const encoder = new TextEncoder();
const decoder = new TextDecoder();

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
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

async function generateSecMsGec(nowMs = Date.now() + clockSkewMs) {
    const roundedUnixSeconds = BigInt(Math.floor(nowMs / 1000 / 300) * 300);
    const ticks = (roundedUnixSeconds + WINDOWS_EPOCH_SECONDS) * TICKS_PER_SECOND;
    const value = `${ticks}${TRUSTED_CLIENT_TOKEN}`;
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
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
