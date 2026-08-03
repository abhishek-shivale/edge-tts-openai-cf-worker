const assert = require("node:assert/strict");
const { createHash, webcrypto } = require("node:crypto");
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

test("generates current Sec-MS-GEC token", async () => {
    const now = Date.UTC(2026, 7, 3, 10, 7, 12);
    const roundedSeconds = Math.floor(now / 1000 / 300) * 300;
    const ticks = (BigInt(roundedSeconds) + 11644473600n) * 10000000n;
    const expected = createHash("sha256")
        .update(`${ticks}6A5AA1D4EAFF4E9FB37E23D68491D6F4`, "ascii")
        .digest("hex")
        .toUpperCase();

    assert.equal(await generateSecMsGec(now), expected);
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
