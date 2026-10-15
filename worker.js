const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WINDOWS_EPOCH_SECONDS = 11644473600n;
const TICKS_PER_SECOND = 10000000n;
const MAX_CHUNK_BYTES = 4096;
const MAX_SYNTHESIS_CHUNKS = 8;
const MAX_ESCAPED_INPUT_BYTES = MAX_CHUNK_BYTES * MAX_SYNTHESIS_CHUNKS;
const WEB_SOCKET_TIMEOUT_MS = 30000;

let clockSkewMs = 0;

const API_KEY = globalThis.API_KEY;

const VOICE_MAPPING = {
    alloy: "zh-CN-XiaoxiaoNeural",
    echo: "zh-CN-YunxiNeural",
    fable: "zh-CN-XiaoyiNeural",
    onyx: "zh-CN-YunyangNeural",
    nova: "zh-CN-XiaohanNeural",
    shimmer: "zh-CN-XiaomengNeural"
};

class ApiError extends Error {
    constructor(message, status = 500, code = "edge_tts_error", upstreamStatus = null) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
        this.upstreamStatus = upstreamStatus;
    }
}

if (typeof addEventListener === "function") {
    addEventListener("fetch", event => {
        event.respondWith(handleRequest(event.request));
    });
}

async function handleRequest(request) {
    if (request.method === "OPTIONS") {
        return handleOptions(request);
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== "/v1/audio/speech") {
        return new Response("Not Found", { status: 404, headers: makeCORSHeaders() });
    }

    if (request.method !== "POST") {
        return errorResponse(new ApiError("Method must be POST", 405, "method_not_allowed"));
    }

    if (API_KEY) {
        const authHeader = request.headers.get("authorization");
        const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (apiKey !== API_KEY) {
            return errorResponse(new ApiError(
                "Invalid API key. Use 'Authorization: Bearer your-api-key' header",
                401,
                "invalid_api_key"
            ));
        }
    }

    try {
        let requestBody;
        try {
            requestBody = await request.json();
        } catch {
            throw new ApiError("Request body must be valid JSON", 400, "invalid_request_error");
        }

        const options = validateSpeechRequest(requestBody);
        const audio = await getVoice(options);
        return new Response(audio, {
            headers: {
                "Content-Type": "audio/mpeg",
                "Cache-Control": "no-store",
                ...makeCORSHeaders()
            }
        });
    } catch (error) {
        const normalizedError = normalizeError(error);
        console.error(JSON.stringify({
            event: "speech_synthesis_failed",
            message: normalizedError.message,
            status: normalizedError.status,
            upstreamStatus: normalizedError.upstreamStatus,
            stack: normalizedError.stack
        }));
        return errorResponse(normalizedError);
    }
}

function validateSpeechRequest(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError("Request body must be a JSON object", 400, "invalid_request_error");
    }

    const {
        model = "tts-1",
        input,
        voice: requestedVoice = "zh-CN-XiaoxiaoNeural",
        response_format: responseFormat = "mp3",
        speed = 1.0,
        pitch = 1.0,
        style = "general"
    } = body;

    if (typeof model !== "string" || model.length === 0) {
        throw new ApiError("model must be a non-empty string", 400, "invalid_request_error");
    }
    if (typeof input !== "string" || input.trim().length === 0) {
        throw new ApiError("input must be a non-empty string", 400, "invalid_request_error");
    }
    if (input.length > 100000) {
        throw new ApiError("input exceeds 100000 characters", 400, "invalid_request_error");
    }
    if (input.length > MAX_ESCAPED_INPUT_BYTES || escapedTextByteLength(input) > MAX_ESCAPED_INPUT_BYTES) {
        throw new ApiError(
            `input is too long for one request; split input into chunks of at most ${MAX_ESCAPED_INPUT_BYTES} escaped bytes`,
            413,
            "input_too_large"
        );
    }
    if (typeof requestedVoice !== "string") {
        throw new ApiError("voice must be a string", 400, "invalid_request_error");
    }

    const voice = VOICE_MAPPING[requestedVoice] || requestedVoice;
    if (!/^[a-z]{2,}-[A-Z]{2,}-(?:[A-Za-z0-9]+-)*[A-Za-z0-9]+Neural$/.test(voice)) {
        throw new ApiError(`Invalid voice: ${requestedVoice}`, 400, "invalid_request_error");
    }
    if (responseFormat !== "mp3") {
        throw new ApiError("Only response_format 'mp3' is supported", 400, "invalid_request_error");
    }
    if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
        throw new ApiError("speed must be a number between 0.5 and 2.0", 400, "invalid_request_error");
    }
    if (typeof pitch !== "number" || !Number.isFinite(pitch) || pitch < 0.5 || pitch > 2.0) {
        throw new ApiError("pitch must be a number between 0.5 and 2.0", 400, "invalid_request_error");
    }
    if (typeof style !== "string") {
        throw new ApiError("style must be a string", 400, "invalid_request_error");
    }

    return {
        input,
        voice,
        rate: signedValue(Math.round((speed - 1) * 100), "%"),
        pitch: signedValue(Math.round((pitch - 1) * 100), "Hz"),
        outputFormat: "audio-24khz-48kbitrate-mono-mp3"
    };
}

async function getVoice({ input, voice, rate, pitch, outputFormat }) {
    const chunks = splitText(input, MAX_CHUNK_BYTES);
    if (chunks.length > MAX_SYNTHESIS_CHUNKS) {
        throw new ApiError(
            `input requires too many synthesis chunks; split input into smaller requests (maximum ${MAX_SYNTHESIS_CHUNKS})`,
            413,
            "input_too_large"
        );
    }
    const audioChunks = [];

    // Sequential connections avoid upstream throttling and Workers subrequest pressure.
    for (const chunk of chunks) {
        audioChunks.push(await getAudioChunk(chunk, voice, rate, pitch, outputFormat));
    }

    return new Blob(audioChunks, { type: "audio/mpeg" });
}

async function getAudioChunk(escapedText, voice, rate, pitch, outputFormat) {
    try {
        return await synthesizeChunk(escapedText, voice, rate, pitch, outputFormat);
    } catch (error) {
        if (error?.upstreamStatus !== 403 || !Number.isFinite(error.serverTimeMs)) {
            throw error;
        }

        clockSkewMs = error.serverTimeMs - Date.now();
        return synthesizeChunk(escapedText, voice, rate, pitch, outputFormat);
    }
}

async function synthesizeChunk(escapedText, voice, rate, pitch, outputFormat) {
    const connectionId = uuid();
    const token = await generateSecMsGec();
    const url = `https://${EDGE_BASE_URL}/edge/v1` +
        `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
        `&ConnectionId=${connectionId}` +
        `&Sec-MS-GEC=${token}` +
        `&Sec-MS-GEC-Version=${encodeURIComponent(SEC_MS_GEC_VERSION)}`;

    const response = await fetchWithTimeout(url, {
        headers: {
            Upgrade: "websocket",
            Pragma: "no-cache",
            "Cache-Control": "no-cache",
            Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
            "User-Agent": edgeUserAgent(),
            Cookie: `muid=${uuid().toUpperCase()};`
        }
    }, WEB_SOCKET_TIMEOUT_MS);

    if (!response.webSocket) {
        const responseText = await safeResponseText(response);
        const error = new ApiError(
            `Edge TTS WebSocket handshake failed: ${response.status}${responseText ? ` ${responseText}` : ""}`,
            502,
            "edge_tts_upstream_error",
            response.status
        );
        const serverTime = Date.parse(response.headers.get("Date") || "");
        error.serverTimeMs = Number.isFinite(serverTime) ? serverTime : null;
        throw error;
    }

    const webSocket = response.webSocket;
    webSocket.binaryType = "arraybuffer";
    webSocket.accept();

    return receiveAudio(webSocket, escapedText, voice, rate, pitch, outputFormat);
}

function receiveAudio(webSocket, escapedText, voice, rate, pitch, outputFormat) {
    return new Promise((resolve, reject) => {
        const audioChunks = [];
        let settled = false;

        const timer = setTimeout(() => {
            fail(new ApiError("Edge TTS WebSocket timed out", 504, "edge_tts_timeout"));
        }, WEB_SOCKET_TIMEOUT_MS);

        function cleanup() {
            clearTimeout(timer);
            webSocket.removeEventListener("message", onMessage);
            webSocket.removeEventListener("error", onError);
            webSocket.removeEventListener("close", onClose);
        }

        function finish() {
            if (settled) return;
            settled = true;
            cleanup();
            closeWebSocket(webSocket, "done");
            if (audioChunks.length === 0) {
                reject(new ApiError(
                    "Edge TTS returned no audio. Verify voice and parameters.",
                    502,
                    "edge_tts_no_audio"
                ));
                return;
            }
            resolve(new Blob(audioChunks, { type: "audio/mpeg" }));
        }

        function fail(error) {
            if (settled) return;
            settled = true;
            cleanup();
            closeWebSocket(webSocket, "synthesis failed");
            reject(normalizeError(error));
        }

        function onMessage(event) {
            handleWebSocketMessage(event.data, audioChunks, finish).catch(fail);
        }

        function onError() {
            fail(new ApiError("Edge TTS WebSocket error", 502, "edge_tts_upstream_error"));
        }

        function onClose(event) {
            if (!settled) {
                fail(new ApiError(
                    `Edge TTS WebSocket closed before completion: ${event.code} ${event.reason || ""}`.trim(),
                    502,
                    "edge_tts_upstream_error"
                ));
            }
        }

        webSocket.addEventListener("message", onMessage);
        webSocket.addEventListener("error", onError);
        webSocket.addEventListener("close", onClose);

        try {
            webSocket.send(makeSpeechConfig(outputFormat));
            webSocket.send(makeSsmlRequest(escapedText, voice, rate, pitch));
        } catch (error) {
            fail(error);
        }
    });
}

async function handleWebSocketMessage(data, audioChunks, finish) {
    if (typeof data === "string") {
        const { headers } = parseProtocolMessage(data);
        const path = headers.path;
        if (path === "turn.end") finish();
        if (path && !["turn.start", "turn.end", "response", "audio.metadata"].includes(path)) {
            throw new ApiError(`Unexpected Edge TTS message path: ${path}`, 502, "edge_tts_protocol_error");
        }
        return;
    }

    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    if (!(buffer instanceof ArrayBuffer)) {
        throw new ApiError("Unexpected Edge TTS binary message type", 502, "edge_tts_protocol_error");
    }

    const parsed = parseAudioMessage(buffer);
    if (parsed.contentType === "audio/mpeg" && parsed.audio.byteLength > 0) {
        audioChunks.push(parsed.audio);
    } else if (parsed.contentType !== null || parsed.audio.byteLength > 0) {
        throw new ApiError("Invalid Edge TTS audio frame", 502, "edge_tts_protocol_error");
    }
}

function parseAudioMessage(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength < 2) {
        throw new ApiError("Edge TTS audio frame missing header length", 502, "edge_tts_protocol_error");
    }

    const headerLength = new DataView(buffer).getUint16(0, false);
    const audioOffset = 2 + headerLength;
    if (audioOffset > bytes.byteLength) {
        throw new ApiError("Edge TTS audio frame has invalid header length", 502, "edge_tts_protocol_error");
    }

    const headerText = decoder.decode(bytes.slice(2, audioOffset));
    const headers = parseHeaders(headerText);
    if (headers.path !== "audio") {
        throw new ApiError("Unexpected Edge TTS binary message path", 502, "edge_tts_protocol_error");
    }

    return {
        contentType: headers["content-type"] || null,
        audio: bytes.subarray(audioOffset)
    };
}

function parseProtocolMessage(message) {
    const separator = message.indexOf("\r\n\r\n");
    if (separator < 0) {
        throw new ApiError("Malformed Edge TTS protocol message", 502, "edge_tts_protocol_error");
    }
    return {
        headers: parseHeaders(message.slice(0, separator)),
        body: message.slice(separator + 4)
    };
}

function parseHeaders(headerText) {
    const headers = {};
    for (const line of headerText.split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator > 0) {
            headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        }
    }
    return headers;
}

function makeSpeechConfig(outputFormat) {
    const config = {
        context: {
            synthesis: {
                audio: {
                    metadataoptions: {
                        sentenceBoundaryEnabled: "false",
                        wordBoundaryEnabled: "false"
                    },
                    outputFormat
                }
            }
        }
    };
    return `X-Timestamp:${edgeTimestamp()}\r\n` +
        "Content-Type:application/json; charset=utf-8\r\n" +
        "Path:speech.config\r\n\r\n" +
        `${JSON.stringify(config)}\r\n`;
}

function makeSsmlRequest(escapedText, voice, rate, pitch) {
    const timestamp = edgeTimestamp();
    const ssml = getSsml(escapedText, voice, rate, pitch);
    return `X-RequestId:${uuid()}\r\n` +
        "Content-Type:application/ssml+xml\r\n" +
        `X-Timestamp:${timestamp}Z\r\n` +
        "Path:ssml\r\n\r\n" +
        ssml;
}

function getSsml(escapedText, voice, rate, pitch) {
    const edgeVoice = normalizeVoiceName(voice);
    return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        `<voice name='${escapeXmlAttribute(edgeVoice)}'>` +
        `<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${escapedText}</prosody>` +
        "</voice></speak>";
}

function normalizeVoiceName(voice) {
    const match = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(voice);
    if (!match) return voice;

    let [, language, region, name] = match;
    const separator = name.indexOf("-");
    if (separator !== -1) {
        region = `${region}-${name.slice(0, separator)}`;
        name = name.slice(separator + 1);
    }
    return `Microsoft Server Speech Text to Speech Voice (${language}-${region}, ${name})`;
}

function splitText(text, maxBytes) {
    const cleanText = removeIncompatibleCharacters(text);
    const chunks = [];
    let chunk = "";
    let byteLength = 0;
    let lastBoundary = -1;

    function flush(preferBoundary = true) {
        const boundary = preferBoundary && lastBoundary >= 0 ? lastBoundary : chunk.length;
        const completeChunk = chunk.slice(0, boundary).trim();
        if (completeChunk) chunks.push(completeChunk);
        chunk = chunk.slice(boundary);
        byteLength = utf8ByteLength(chunk);
        lastBoundary = -1;
    }

    for (const character of cleanText) {
        const escaped = escapeXmlCharacter(character);
        const escapedBytes = utf8ByteLength(escaped);
        while (byteLength + escapedBytes > maxBytes && chunk.length > 0) {
            flush();
        }
        chunk += escaped;
        byteLength += escapedBytes;
        if (/\s/u.test(character)) lastBoundary = chunk.length;
    }
    if (chunk) flush(false);

    if (chunks.length === 0) {
        throw new ApiError("input contains no synthesizable characters", 400, "invalid_request_error");
    }
    return chunks;
}

function closeWebSocket(webSocket, reason) {
    if (webSocket.readyState !== 0 && webSocket.readyState !== 1) return;
    try {
        webSocket.close(1000, reason);
    } catch {
        // Connection is already closing or runtime rejected a redundant close.
    }
}

function removeIncompatibleCharacters(text) {
    return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

function escapedTextByteLength(text) {
    let total = 0;
    for (const character of text) {
        total += utf8ByteLength(escapeXmlCharacter(character));
    }
    return total;
}

function utf8ByteLength(value) {
    let total = 0;
    for (let index = 0; index < value.length;) {
        const codePoint = value.codePointAt(index);
        total += codePoint <= 0x7F ? 1 : codePoint <= 0x7FF ? 2 : codePoint <= 0xFFFF ? 3 : 4;
        index += codePoint > 0xFFFF ? 2 : 1;
    }
    return total;
}

function escapeXmlText(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlCharacter(character) {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    return character;
}

function escapeXmlAttribute(value) {
    return escapeXmlText(value).replace(/'/g, "&apos;").replace(/\"/g, "&quot;");
}

// Sec-MS-GEC v2 (required since 2026-10-13): "<CS64 hex>-<modified SHA-256 hex>".
// Port of rany2/edge-tts 7.3.1 drm.py; the constants are Microsoft's, not standard SHA-256.
const SHA256_INITIAL = [
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19
];
const SHA256_STATE = [
    0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2
];
const SHA256_SCHEDULE = [
    0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0,
    0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564
];
const SHA256_K = [
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
];
const SHA256_ADJUSTMENT = 0xC9DC06A7;
const SHA256_K_ADJUSTED = SHA256_K.map((value, index) => index === 14 ? SHA256_ADJUSTMENT : value);
const SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;
const CS64_COEFFICIENTS = [
    [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038],
    [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C],
    [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA],
    [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
    [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167]
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xF2F90B1A;
const CS64_ADJUSTMENT1 = 0x0B1A0000;

const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));
const rol16 = value => ((value << 16) | (value >>> 16)) >>> 0;
const sigma0 = value => (rotr(value, 7) ^ rotr(value, 18) ^ (value >>> 3)) >>> 0;
const sigma1 = value => (rotr(value, 17) ^ rotr(value, 19) ^ (value >>> 10)) >>> 0;
const mul32 = (a, b) => Math.imul(a, b) >>> 0;
const addState = (a, b) => a.map((value, index) => (value + b[index]) >>> 0);

function expandSha256Schedule(words, firstWord = 16) {
    for (let i = firstWord; i < 64; i++) {
        words[i] = (sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0;
    }
}

function sha256Rounds(state, words, firstRound = 0) {
    const k = firstRound === 14 ? SHA256_K_ADJUSTED : SHA256_K;
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = firstRound; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (g ^ (e & (f ^ g))) + k[i] + words[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) | (c & (a | b)))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    return [a, b, c, d, e, f, g, h];
}

function sha256Init(data) {
    const words = new Array(14).fill(0);
    words.push((data[0] << 16) | (data[1] << 8) | data[2]);
    words.push(((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0);
    for (let i = 16; i < 30; i++) {
        let value = SHA256_SCHEDULE[i - 16];
        value += i === 16 ? (sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : sigma1(words[i - 2]);
        if (i >= 21) value += words[i - 7];
        if (i === 29) value += (sigma0(words[14]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0;
        words.push(value >>> 0);
    }
    words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] +
        SHA256_ADJUSTMENT - SHA256_K[14]) >>> 0);
    expandSha256Schedule(words, 31);
    return addState(SHA256_INITIAL, sha256Rounds(SHA256_STATE, words, 14));
}

function sha256Digest(data) {
    const length = 57 + data.length;
    const padding = (((55 - length) % 64) + 64) % 64;
    const padded = new Uint8Array(data.length - 7 + 1 + padding + 8);
    padded.set(data.subarray(7));
    padded[data.length - 7] = 0x80;
    const view = new DataView(padded.buffer);
    view.setBigUint64(padded.length - 8, BigInt(length * 8));

    let state = sha256Init(data);
    for (let offset = 0; offset < padded.length; offset += 64) {
        const words = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4));
        expandSha256Schedule(words);
        state = addState(state, sha256Rounds(state, words));
    }

    const digest = new Uint8Array(32);
    const digestView = new DataView(digest.buffer);
    state.forEach((value, i) => digestView.setUint32(i * 4, value));
    return digest;
}

function cs64Digest(data, digest) {
    const digestView = new DataView(digest.buffer);
    const keyA = (digestView.getUint32(0, true) | 1) >>> 0;
    const keyB = (digestView.getUint32(4, true) | 1) >>> 0;
    const factors = [mul32(keyA, CS64_FACTOR), mul32(keyB, CS64_FACTOR)];
    const terms = CS64_COEFFICIENTS.map(([coefficient], i) => mul32(coefficient, factors[i % 2]));
    const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);

    // Little-endian words of "\0" + data, zero-padded to an even word count.
    const wordCount = Math.ceil((data.length + 1) / 4);
    const bytes = new Uint8Array((wordCount + (wordCount % 2)) * 4);
    bytes.set(data, 1);
    const bytesView = new DataView(bytes.buffer);
    for (let i = 0; i < bytes.length / 4; i++) {
        const word = bytesView.getUint32(i * 4, true);
        const even = i % 2 === 0;
        let term = mul32(word, even ? keyA : keyB);
        let offset = mul32(rol16(word), even ? 0xEF0569FB : 0xC31713DB);
        if (i === 0) {
            term = (term + mul32(CS64_ADJUSTMENT0, factors[0])) >>> 0;
            offset = (offset + CS64_ADJUSTMENT1) >>> 0;
        }
        terms.push(term);
        offsets.push(offset);
    }

    let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
    for (let i = 0; i < terms.length; i += 2) {
        const x = terms[i], y = terms[i + 1];
        let q = mul32(rol16((offsets[i] + x) >>> 0), 0x76F50F34);
        swapAcc = (swapAcc + mul32(rol16(q), 0xC3EFEA97) + q) >>> 0;
        q = mul32(rol16((offsets[i + 1] + y) >>> 0), 0x1881CE3C);
        swapLast = (mul32(rol16(q), 0x35BD1EC9) + q) >>> 0;
        swapAcc = (swapAcc + swapLast) >>> 0;

        state = (mul32(state, keyA) + x) >>> 0;
        state = mul32(rol16(state), 0xCF98B111);
        state = mul32(rol16(state), 0x87085B9F);
        state = mul32(rol16(state), 0x12CEB96D);
        state = mul32(rol16(state), 0x257E1D83);
        acc = (acc + state) >>> 0;
        let t = (mul32(state, keyB) + y) >>> 0;
        t = mul32(rol16(t), 0xA27416F5);
        t = mul32(rol16(t), 0xD38396FF);
        state = mul32(rol16(mul32(rol16(t), 0x7C932B89)), 0xBFA49F69);
        acc = (acc + state) >>> 0;
    }
    return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();

function generateSecMsGec(nowMs = Date.now() + clockSkewMs) {
    const roundedUnixSeconds = BigInt(Math.floor(nowMs / 1000 / 300) * 300);
    const ticks = (roundedUnixSeconds + WINDOWS_EPOCH_SECONDS) * TICKS_PER_SECOND;
    const data = encoder.encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`);
    const digest = sha256Digest(data);
    const cs64 = new Uint8Array(8);
    const cs64View = new DataView(cs64.buffer);
    cs64Digest(data, digest).forEach((value, i) => cs64View.setUint32(i * 4, value, true));
    return `${toHex(cs64)}-${toHex(digest)}`;
}

function edgeTimestamp(date = new Date()) {
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const pad = value => String(value).padStart(2, "0");
    return `${weekdays[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ` +
        `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
        `${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function edgeUserAgent() {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 ` +
        `Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;
}

function signedValue(value, unit) {
    return `${value >= 0 ? "+" : ""}${value}${unit}`;
}

function uuid() {
    return crypto.randomUUID().replace(/-/g, "");
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new ApiError("Edge TTS connection timed out", 504, "edge_tts_timeout");
        }
        throw new ApiError(`Edge TTS connection failed: ${error?.message || String(error)}`, 502, "edge_tts_upstream_error");
    } finally {
        clearTimeout(timer);
    }
}

async function safeResponseText(response) {
    try {
        return (await response.text()).replace(/\s+/g, " ").trim().slice(0, 500);
    } catch {
        return "";
    }
}

function normalizeError(error) {
    if (error instanceof ApiError) return error;
    return new ApiError(error?.message || String(error), 500, "edge_tts_error");
}

function errorResponse(error) {
    const normalizedError = normalizeError(error);
    const headers = {
        "Content-Type": "application/json",
        ...makeCORSHeaders()
    };
    if (normalizedError.status === 405) headers.Allow = "POST, OPTIONS";

    return new Response(JSON.stringify({
        error: {
            message: normalizedError.message,
            type: normalizedError.status < 500 ? "invalid_request_error" : "api_error",
            param: null,
            code: normalizedError.code
        }
    }), { status: normalizedError.status, headers });
}

function handleOptions(request) {
    return new Response(null, {
        status: 204,
        headers: {
            ...makeCORSHeaders(),
            "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") ||
                "Authorization, Content-Type"
        }
    });
}

function makeCORSHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "86400"
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        ApiError,
        edgeTimestamp,
        escapeXmlText,
        generateSecMsGec,
        getSsml,
        normalizeVoiceName,
        parseAudioMessage,
        splitText,
        validateSpeechRequest
    };
}
