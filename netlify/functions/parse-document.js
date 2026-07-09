const zlib = require("zlib");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const filename = String(payload.filename || "").toLowerCase();
    const buffer = Buffer.from(payload.data || "", "base64");

    if (!buffer.length) {
      return json(400, { error: "파일 데이터가 없습니다." });
    }

    if (filename.endsWith(".docx")) {
      const text = extractDocxText(buffer);
      return json(200, { text, method: "DOCX 텍스트 추출 완료" });
    }

    if (filename.endsWith(".pdf")) {
      const text = extractPdfText(buffer);
      return json(200, { text, method: "PDF 텍스트 추출 완료" });
    }

    if (filename.endsWith(".pptx")) {
      const text = extractPptxText(buffer);
      return json(200, { text, method: "PPTX 슬라이드 텍스트 추출 완료" });
    }

    return json(400, { error: "PDF, DOCX 또는 PPTX 파일만 지원합니다." });
  } catch (error) {
    return json(500, { error: error.message || "문서 텍스트 추출 실패" });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
}

function extractDocxText(buffer) {
  const xml = readZipEntry(buffer, "word/document.xml");
  if (!xml) throw new Error("DOCX 본문을 찾지 못했습니다.");

  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)
    ?.map((node) =>
      node
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
    )
    .join(" ")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim() || "";
}

function readZipEntry(buffer, targetName) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error("DOCX ZIP 구조를 읽지 못했습니다.");

  const entries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entries; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .slice(offset + 46, offset + 46 + fileNameLength)
      .toString("utf8");

    if (name === targetName) {
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      const data =
        compression === 0
          ? compressed
          : compression === 8
            ? zlib.inflateRawSync(compressed)
            : null;
      if (!data) throw new Error("지원하지 않는 DOCX 압축 방식입니다.");
      return data.toString("utf8");
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return "";
}

function readZipEntries(buffer, predicate) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error("ZIP 구조를 읽지 못했습니다.");

  const entries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const matches = [];
  let offset = centralDirectoryOffset;

  for (let i = 0; i < entries; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .slice(offset + 46, offset + 46 + fileNameLength)
      .toString("utf8");

    if (predicate(name)) {
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      const data =
        compression === 0
          ? compressed
          : compression === 8
            ? zlib.inflateRawSync(compressed)
            : null;
      if (data) matches.push({ name, text: data.toString("utf8") });
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return matches;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function extractPptxText(buffer) {
  const slides = readZipEntries(
    buffer,
    (name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name),
  ).sort((a, b) => {
    const aNumber = Number(a.name.match(/slide(\d+)\.xml/i)?.[1] || 0);
    const bNumber = Number(b.name.match(/slide(\d+)\.xml/i)?.[1] || 0);
    return aNumber - bNumber;
  });

  if (!slides.length) throw new Error("PPTX 슬라이드 본문을 찾지 못했습니다.");

  const text = slides
    .map((slide, index) => {
      const items = [...slide.text.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
        .map((match) => decodeXmlText(match[1]))
        .filter(Boolean);
      return items.length ? `[슬라이드 ${index + 1}]\n${items.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!text) throw new Error("PPTX에서 텍스트를 추출하지 못했습니다.");
  return text;
}

function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function extractPdfText(buffer) {
  const source = buffer.toString("latin1");
  const chunks = [source];
  const streamPattern = /<<(?:.|\n|\r)*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;

  while ((match = streamPattern.exec(source))) {
    const header = match[0].slice(0, Math.min(match[0].indexOf("stream"), 400));
    const raw = Buffer.from(match[1], "latin1");
    if (/FlateDecode/.test(header)) {
      try {
        chunks.push(zlib.inflateSync(raw).toString("latin1"));
      } catch (error) {
        try {
          chunks.push(zlib.inflateRawSync(raw).toString("latin1"));
        } catch (innerError) {
          chunks.push(match[1]);
        }
      }
    } else {
      chunks.push(match[1]);
    }
  }

  const text = chunks
    .flatMap((chunk) => extractPdfTextOperators(chunk))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!text) {
    throw new Error("PDF에서 텍스트를 추출하지 못했습니다. 스캔 PDF일 수 있습니다.");
  }

  return text;
}

function extractPdfTextOperators(text) {
  const output = [];
  const literalPattern = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  const arrayPattern = /\[((?:.|\n|\r)*?)\]\s*TJ/g;
  const hexPattern = /<([0-9a-fA-F\s]+)>\s*Tj/g;
  let match;

  while ((match = literalPattern.exec(text))) {
    output.push(decodePdfLiteral(match[0].replace(/\)\s*Tj$/, "").slice(1)));
  }

  while ((match = arrayPattern.exec(text))) {
    const part = match[1];
    const literals = [...part.matchAll(/\((?:\\.|[^\\)])*\)/g)].map((item) =>
      decodePdfLiteral(item[0].slice(1, -1)),
    );
    const hexes = [...part.matchAll(/<([0-9a-fA-F\s]+)>/g)].map((item) =>
      decodePdfHex(item[1]),
    );
    output.push([...literals, ...hexes].join(""));
  }

  while ((match = hexPattern.exec(text))) {
    output.push(decodePdfHex(match[1]));
  }

  return output.filter(Boolean);
}

function decodePdfLiteral(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
    .trim();
}

function decodePdfHex(value) {
  const cleaned = value.replace(/\s+/g, "");
  if (!cleaned) return "";
  const buffer = Buffer.from(cleaned.length % 2 ? `${cleaned}0` : cleaned, "hex");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const source = buffer.slice(2);
    const swapped = Buffer.alloc(source.length);
    for (let i = 0; i < source.length; i += 2) {
      swapped[i] = source[i + 1] || 0;
      swapped[i + 1] = source[i] || 0;
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8").replace(/\0/g, "").trim();
}
