const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const test = require("node:test");

globalThis.crypto ??= webcrypto;

const {
    edgeTimestamp,
    escapeXmlText,
    generateSecMsGec,
    getSsml,
    normalizeVoiceName,
    parseAudioMessage,
    splitText,
    validateSpeechRequest
} = require("./worker.js");

test("validates and converts OpenAI-compatible parameters", () => {
    const options = validateSpeechRequest({
        input: "hello",
        voice: "alloy",
        speed: 1.2,
        pitch: 0.9
    });

    assert.equal(options.voice, "zh-CN-XiaoxiaoNeural");
    assert.equal(options.rate, "+20%");
    assert.equal(options.pitch, "-10Hz");
    assert.throws(
        () => validateSpeechRequest({ input: "hello", voice: "bad<voice" }),
        /Invalid voice/
    );
    assert.throws(
        () => validateSpeechRequest({ input: "hello", response_format: "wav" }),
        /Only response_format 'mp3'/
    );
});

test("rejects input that would require too many upstream connections", () => {
    assert.throws(
        () => validateSpeechRequest({ input: "a".repeat(32769) }),
        error => error.status === 413 && error.code === "input_too_large"
    );
});

test("escapes text and emits Edge-compatible SSML", () => {
    const escaped = escapeXmlText("A & B < C > D");
    const ssml = getSsml(escaped, "en-US-JennyNeural", "+0%", "+0Hz");

    assert.match(ssml, /A &amp; B &lt; C &gt; D/);
    assert.match(ssml, /Microsoft Server Speech Text to Speech Voice \(en-US, JennyNeural\)/);
    assert.doesNotMatch(ssml, /mstts:express-as/);
});

test("splits escaped UTF-8 text without exceeding byte limit", () => {
    const chunks = splitText("你&".repeat(3000), 4096);

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
        assert.ok(Buffer.byteLength(chunk) <= 4096);
        assert.doesNotMatch(chunk, /&(?!amp;|lt;|gt;)/);
    }
    assert.deepEqual(splitText("a b c", 3), ["a", "b c"]);
});

test("parses Edge binary audio frames", () => {
    const header = Buffer.from("Path:audio\r\nContent-Type:audio/mpeg\r\n");
    const audio = Buffer.from([0x49, 0x44, 0x33]);
    const frame = Buffer.alloc(2 + header.length + audio.length);
    frame.writeUInt16BE(header.length, 0);
    header.copy(frame, 2);
    audio.copy(frame, 2 + header.length);

    const parsed = parseAudioMessage(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
    assert.equal(parsed.contentType, "audio/mpeg");
    assert.deepEqual(Buffer.from(parsed.audio), audio);
});

test("generates Sec-MS-GEC v2 tokens matching edge-tts 7.3.1", () => {
    // Reference values from rany2/edge-tts drm.generate_sec_ms_gec_v2(unix_seconds).
    const vectors = {
        0: "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
        1700000000: "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
        1785751632: "8F430F39A2975CD8-4ECE859CB0A008369DB09EFEBAAD5F08E35AA8C6A56BB96149A460E4C517CC5A",
        1792078900: "435FD64D0FCDBA44-17127C17B6E696D592A00D33BE4D24E87FCF3B64CE74CA9B45BFDD86836792FD"
    };

    for (const [seconds, expected] of Object.entries(vectors)) {
        assert.equal(generateSecMsGec(Number(seconds) * 1000), expected);
    }
});

test("formats Edge timestamps and regional voice names", () => {
    assert.equal(
        edgeTimestamp(new Date(Date.UTC(2026, 7, 3, 10, 7, 12))),
        "Mon Aug 03 2026 10:07:12 GMT+0000 (Coordinated Universal Time)"
    );
    assert.equal(
        normalizeVoiceName("zh-CN-liaoning-XiaobeiNeural"),
        "Microsoft Server Speech Text to Speech Voice (zh-CN-liaoning, XiaobeiNeural)"
    );
});
