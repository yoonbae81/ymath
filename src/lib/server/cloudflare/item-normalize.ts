/** Worker(WASM) 이미지 정규화 — 기존 Node runner 의 processImage() 정책을 따르되,
 * Workers 환경 제약으로 입력 형식을 JPEG/PNG/WebP 로 한정한다(정책 차이는
 * docs/inngest-item-analysis-results.md 에 기록). 50Mpx 는 decode 전에 거절한다. */
import { PhotonImage, SamplingFilter, grayscale, resize } from '@cf-wasm/photon';
import { imageSize } from 'image-size';
import * as exifr from 'exifr';
import { hasImageMagicBytes } from './runtime';

export const NORMALIZE_MAX_SIDE = 1600;
export const NORMALIZE_MAX_INPUT_PIXELS = 50_000_000;
const ALLOWED_TYPES = new Set(['jpg', 'jpeg', 'png', 'webp']);

/** Worker 런타임 판별 — workerd 에서는 jSquash 에 WASM 모듈을 명시 전달해야 한다. */
const IS_WORKERS_RUNTIME = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';

type JpegEncode = (data: { data: Uint8Array; width: number; height: number }, options: { quality: number; color_space: number }) => Promise<Uint8Array>;
let jpegEncoder: Promise<JpegEncode> | null = null;
async function jpegEncoderForRuntime(): Promise<JpegEncode> {
	if (!jpegEncoder) {
		jpegEncoder = (async () => {
			const mod = (await import('@jsquash/jpeg/encode.js')) as unknown as {
				init(module?: unknown): Promise<void> | void;
				default: (data: { data: Uint8Array; width: number; height: number }, options: { quality: number; color_space: number }) => Promise<ArrayBuffer>;
			};
			if (IS_WORKERS_RUNTIME) {
				// Vite preserves this static module import; Wrangler emits CompiledWasm.
				const { default: wasmModule } = await import('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm');
				await mod.init(wasmModule);
			} else {
				// Node(vitest/로컬): glue 가 web 전용 빌드라 fs 로 직접 컴파일해 전달한다.
				// 이 분기는 Workers 에서 실행되지 않고, 정적 node:fs import 가 번들에 유입되지 않게
				// process.getBuiltinModule 로만 접근한다(Worker 번들 경계 검사 통과 유지).
				const builtin = (process as unknown as { getBuiltinModule?: (id: string) => { readFile(path: string): Promise<Buffer> } | undefined }).getBuiltinModule?.('node:fs/promises');
				const nodeModule = (process as unknown as { getBuiltinModule?: (id: string) => { createRequire(meta: string): { resolve(id: string): string } } }).getBuiltinModule?.('node:module');
				if (!builtin || !nodeModule) throw new Error('JPEG encoder initialization is unavailable in this runtime');
				const requireFn = nodeModule.createRequire(import.meta.url);
				const packageJsonPath = requireFn.resolve('@jsquash/jpeg/package.json');
				const wasmBytes = await builtin.readFile(packageJsonPath.replace(/package\.json$/, 'codec/enc/mozjpeg_enc.wasm'));
				await mod.init(await WebAssembly.compile(new Uint8Array(wasmBytes)));
			}
			const encode = mod.default;
			return (async (data, options) => new Uint8Array(await encode(data, options))) as JpegEncode;
		})();
	}
	return jpegEncoder;
}

/** WebP RIFF 컨테이너에서 EXIF 청크만 추출한다(합성 probe에서 검증된 방식). */
function exifPayload(bytes: Uint8Array, type: string | undefined): Uint8Array {
	if (type !== 'webp') return bytes;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let p = 12; p + 8 <= bytes.length;) {
		const n = view.getUint32(p + 4, true);
		if (p + 8 + n > bytes.length) break;
		if (String.fromCharCode(...bytes.subarray(p, p + 4)) === 'EXIF') {
			const start = p + 8;
			return bytes.subarray(start + (bytes[start] === 69 && bytes[start + 1] === 120 ? 6 : 0), start + n);
		}
		p += 8 + n + (n % 2);
	}
	return bytes;
}

/** EXIF orientation 2–8 픽셀 재배치(sharp .rotate() 에 대응). 합성 probe에서 모서리 일치 검증됐다. */
function orient(image: InstanceType<typeof PhotonImage>, orientation: number) {
	if (!(orientation >= 2 && orientation <= 8)) return image;
	const w = image.get_width(), h = image.get_height();
	const src = image.get_raw_pixels();
	const swap = orientation >= 5;
	const ow = swap ? h : w, oh = swap ? w : h;
	const dst = new Uint8Array(src.length);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		let dx: number, dy: number;
		switch (orientation) {
			case 2: dx = w - 1 - x; dy = y; break;
			case 3: dx = w - 1 - x; dy = h - 1 - y; break;
			case 4: dx = x; dy = h - 1 - y; break;
			case 5: dx = y; dy = x; break;
			case 6: dx = h - 1 - y; dy = x; break;
			case 7: dx = h - 1 - y; dy = w - 1 - x; break;
			default: dx = y; dy = w - 1 - x; break;
		}
		const si = (y * w + x) * 4, di = (dy * ow + dx) * 4;
		dst.set(src.subarray(si, si + 4), di);
	}
	return new PhotonImage(dst, ow, oh);
}

export interface NormalizedImage { jpeg: Uint8Array; width: number; height: number }

/** raw 이미지 → EXIF 보정 → 1600 inside 축소 → 그레이스케일 → quality 80 JPEG. */
export async function normalizeCloudImage(input: Uint8Array): Promise<NormalizedImage> {
	if (!hasImageMagicBytes(input)) throw new Error('지원되지 않는 파일 형식이거나 손상된 이미지 파일입니다');
	let meta: ReturnType<typeof imageSize>;
	try { meta = imageSize(input); }
	catch { throw new Error('이미지 헤더를 읽을 수 없습니다'); }
	if (!ALLOWED_TYPES.has(meta.type ?? '')) {
		throw new Error(`지원되지 않는 이미지 포맷입니다: ${meta.type ?? 'unknown'} (Worker 정규화는 JPEG/PNG/WebP만 받습니다)`);
	}
	if (!meta.width || !meta.height || meta.width <= 0 || meta.height <= 0) throw new Error('유효하지 않은 이미지 크기입니다');
	if (meta.width * meta.height > NORMALIZE_MAX_INPUT_PIXELS) throw new Error(`이미지가 너무 큽니다(픽셀 ${meta.width * meta.height} > ${NORMALIZE_MAX_INPUT_PIXELS})`);
	let orientation = 1;
	try { orientation = (await exifr.orientation(exifPayload(input, meta.type))) || 1; } catch { /* EXIF 없음/손상은 무시 */ }
	const raw = PhotonImage.new_from_byteslice(input);
	const owned: InstanceType<typeof PhotonImage>[] = [raw];
	try {
		let img = orient(raw, orientation);
		if (img !== raw) owned.push(img);
		const scale = Math.min(1, NORMALIZE_MAX_SIDE / img.get_width(), NORMALIZE_MAX_SIDE / img.get_height());
		if (scale < 1) {
			const resized = resize(img, Math.max(1, Math.round(img.get_width() * scale)), Math.max(1, Math.round(img.get_height() * scale)), SamplingFilter.Lanczos3);
			owned.push(resized);
			img = resized;
		}
		grayscale(img);
		const encode = await jpegEncoderForRuntime();
		const jpeg = await encode({ data: img.get_raw_pixels(), width: img.get_width(), height: img.get_height() }, { quality: 80, color_space: 1 });
		return { jpeg, width: img.get_width(), height: img.get_height() };
	} finally {
		for (const image of owned.reverse()) image.free();
	}
}
