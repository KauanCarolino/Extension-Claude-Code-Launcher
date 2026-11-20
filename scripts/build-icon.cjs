'use strict';
// Gera media/icon.png (256x256), o ícone de listagem da extensão. Sem dependências: o desenho é
// rasterizado aqui e gravado como PNG, para que o arquivo possa ser refeito e conferido.
// Uso: node scripts/build-icon.cjs [destino.png]

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const UNITS = 28; // mesma grade de media/icon.svg
const SAMPLES = 4; // 4x4 amostras por pixel
const BACKGROUND = [0x1f, 0x23, 0x2b];
const GLYPH = [0xf4, 0xf1, 0xea];

function roundedRect(x, y, left, top, right, bottom, radius) {
	const dx = Math.max(left + radius - x, 0, x - (right - radius));
	const dy = Math.max(top + radius - y, 0, y - (bottom - radius));
	return x >= left && x <= right && y >= top && y <= bottom && dx * dx + dy * dy <= radius * radius;
}
function triangle(x, y, a, b, c) {
	const side = (p, q) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
	const d1 = side(a, b), d2 = side(b, c), d3 = side(c, a);
	return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function nearSegment(x, y, a, b, width) {
	const vx = b[0] - a[0], vy = b[1] - a[1];
	const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy)));
	return Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy)) <= width / 2;
}
// Balão de conversa do ícone da barra de atividades, reduzido para caber na margem do quadro.
function glyph(x, y) {
	const scale = 0.78, cx = 14, cy = 14.4;
	const gx = cx + (x - cx) / scale, gy = cy + (y - cy) / scale;
	const bubble = roundedRect(gx, gy, 3.25, 5.25, 24.75, 19.75, 2.75) || triangle(gx, gy, [9.2, 19.6], [15.6, 19.6], [9.2, 23.6]);
	// Sinal de "abrir": um ">" vazado no balão.
	const chevron = nearSegment(gx, gy, [11.2, 9.3], [15.4, 12.5], 1.9) || nearSegment(gx, gy, [15.4, 12.5], [11.2, 15.7], 1.9);
	return bubble && !chevron;
}

function render() {
	const pixels = Buffer.alloc(SIZE * SIZE * 4);
	for (let py = 0; py < SIZE; py += 1) {
		for (let px = 0; px < SIZE; px += 1) {
			let inside = 0, covered = 0;
			for (let sy = 0; sy < SAMPLES; sy += 1) {
				for (let sx = 0; sx < SAMPLES; sx += 1) {
					const x = (px + (sx + 0.5) / SAMPLES) * UNITS / SIZE, y = (py + (sy + 0.5) / SAMPLES) * UNITS / SIZE;
					if (!roundedRect(x, y, 0, 0, UNITS, UNITS, 6)) { continue; }
					inside += 1;
					if (glyph(x, y)) { covered += 1; }
				}
			}
			const offset = (py * SIZE + px) * 4, total = SAMPLES * SAMPLES, mix = inside ? covered / inside : 0;
			for (let channel = 0; channel < 3; channel += 1) {
				pixels[offset + channel] = Math.round(BACKGROUND[channel] + (GLYPH[channel] - BACKGROUND[channel]) * mix);
			}
			pixels[offset + 3] = Math.round(255 * inside / total);
		}
	}
	return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit += 1) { value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; }
	return value >>> 0;
});
function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) { crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); }
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
	length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}
function png(pixels) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(SIZE, 0); header.writeUInt32BE(SIZE, 4);
	header[8] = 8; header[9] = 6; // 8 bits por canal, RGBA
	const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1));
	for (let y = 0; y < SIZE; y += 1) { pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4); }
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
		chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { render, png, SIZE };

if (require.main === module) {
	const target = path.resolve(process.argv[2] || path.join(__dirname, '..', 'media', 'icon.png'));
	fs.writeFileSync(target, png(render()));
	console.log(`${path.relative(process.cwd(), target)}: ${SIZE}x${SIZE}`);
}
