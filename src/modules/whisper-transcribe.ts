/**
 * Whisper transcription module — transcribes audio attachments on the host
 * before they reach the agent container.
 *
 * Credentials are never stored locally — all API calls route through the
 * OneCLI gateway proxy, which injects the OpenAI API key at request time.
 *
 * Wired into the router: when an inbound message has audio attachments,
 * this module:
 *   1. Reads the audio file from disk (DATA_DIR/attachments/...)
 *   2. Sends it through the OneCLI gateway to the Whisper API
 *   3. Prepends the transcription to the message text
 *
 * Requires: OpenAI secret registered in OneCLI (host pattern: api.openai.com).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { DATA_DIR, ONECLI_URL, ONECLI_API_KEY } from '../config.js';
import { log } from '../log.js';

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const WHISPER_API_URL = process.env.WHISPER_API_URL || 'https://api.openai.com/v1/audio/transcriptions';

/** Audio extensions we'll attempt to transcribe. */
const AUDIO_EXTS = new Set(['.ogg', '.mp3', '.m4a', '.wav', '.aac', '.opus', '.webm', '.mp4', '.mpeg', '.mpga']);

function isAudioFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return AUDIO_EXTS.has(ext);
}

/** Cached proxy config from OneCLI (env vars + CA cert). */
let cachedProxyEnv: Record<string, string> | null = null;
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get OneCLI proxy environment (HTTPS_PROXY, CA certs etc.) for host-side
 * HTTP calls. Caches for 5 minutes.
 */
async function getProxyEnv(): Promise<Record<string, string> | null> {
  if (!ONECLI_URL || !ONECLI_API_KEY) return null;
  if (cachedProxyEnv && Date.now() < cacheExpiry) return cachedProxyEnv;

  try {
    const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
    const config = await onecli.getContainerConfig();
    cachedProxyEnv = config.env;

    // Write CA cert to disk for curl
    if (config.caCertificate) {
      const caPath = '/tmp/onecli-whisper-ca.pem';
      fs.writeFileSync(caPath, config.caCertificate);
      cachedProxyEnv['ONECLI_CA_PATH'] = caPath;
    }

    cacheExpiry = Date.now() + CACHE_TTL;
    log.info('Whisper: OneCLI proxy config cached');
    return cachedProxyEnv;
  } catch (err) {
    log.warn('Whisper: failed to get OneCLI proxy config', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Transcribe an audio file using OpenAI Whisper API via OneCLI gateway.
 * Returns the transcription text, or null on failure.
 */
async function transcribeFile(filePath: string): Promise<string | null> {
  const proxyEnv = await getProxyEnv();
  if (!proxyEnv) {
    log.debug('Whisper transcription skipped — no OneCLI proxy available');
    return null;
  }

  if (!fs.existsSync(filePath)) {
    log.warn('Whisper: audio file not found', { filePath });
    return null;
  }

  try {
    // Use curl with the OneCLI proxy to call Whisper API.
    // The proxy injects the OpenAI API key automatically.
    const curlArgs = [
      '-sS',
      '--max-time',
      '120',
      '-X',
      'POST',
      WHISPER_API_URL,
      '-H',
      'Authorization: Bearer placeholder',
      '-F',
      `model=${WHISPER_MODEL}`,
      '-F',
      `file=@${filePath}`,
    ];

    // Add proxy CA if available
    const caPath = proxyEnv['ONECLI_CA_PATH'];
    if (caPath) {
      curlArgs.push('--cacert', caPath);
    }

    // Build env with proxy settings
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const [k, v] of Object.entries(proxyEnv)) {
      if (k !== 'ONECLI_CA_PATH') env[k] = v;
    }

    const stdout = execFileSync('curl', curlArgs, {
      env,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });

    const result = JSON.parse(stdout) as { text?: string; error?: any };

    if (result.error) {
      log.error('Whisper API returned error', { error: result.error });
      return null;
    }

    if (result.text) {
      log.info('Whisper transcription complete', {
        file: path.basename(filePath),
        length: result.text.length,
      });
      return result.text;
    }
    return null;
  } catch (err) {
    log.error('Whisper transcription failed', {
      filePath: path.basename(filePath),
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Enrich an inbound message content JSON string: if it has audio attachments,
 * transcribe them and prepend the transcription to the text.
 *
 * Returns the (possibly modified) content string.
 */
export async function enrichWithTranscription(content: string): Promise<string> {
  if (!ONECLI_URL || !ONECLI_API_KEY) return content;

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const attachments: any[] = parsed.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return content;

  const audioAttachments = attachments.filter((a) => a.type === 'audio' || (a.name && isAudioFile(a.name)));
  if (audioAttachments.length === 0) return content;

  const transcriptions: string[] = [];

  for (const att of audioAttachments) {
    const localPath = att.localPath ? path.resolve(DATA_DIR, att.localPath) : null;
    if (!localPath) continue;

    const text = await transcribeFile(localPath);
    if (text) {
      transcriptions.push(text);
      att.transcription = text;
    }
  }

  if (transcriptions.length > 0) {
    const prefix =
      transcriptions.length === 1
        ? `🎤 Voice message transcription:\n"${transcriptions[0]}"`
        : transcriptions.map((t, i) => `🎤 Voice message ${i + 1}:\n"${t}"`).join('\n\n');

    parsed.text = prefix + (parsed.text ? `\n\n${parsed.text}` : '');
  }

  return JSON.stringify(parsed);
}
