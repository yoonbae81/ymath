import sharp from 'sharp';

export const MAX_SIDE = 1600;
export const MAX_INPUT_PIXELS = 50_000_000;

/**
 * OCR·LLM 입력과 보관·표시를 겸하는 하나의 이미지: 축소 + 그레이스케일 JPEG.
 * 처음에는 16색 디더링 PNG 를 따로 보관했지만 실제 종이 사진에서는 디더링 노이즈가 압축되지 않아
 * JPEG 보다 2.6배(개당 약 430KB 대 150KB) 컸다. 용량을 줄이려던 목적에 반해 하나로 합쳤다.
 */
export const IMAGE_FILE = 'image.jpg';

/**
 * OWASP ASVS V5.2.2: 업로드된 파일 매직 바이트 검증 (JPEG, PNG, WebP, TIFF)
 */
export function hasValidImageMagicBytes(buf: Buffer): boolean {
	if (!buf || buf.length < 12) return false;
	// JPEG: FF D8 FF
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		buf[0] === 0x89 &&
		buf[1] === 0x50 &&
		buf[2] === 0x4e &&
		buf[3] === 0x47 &&
		buf[4] === 0x0d &&
		buf[5] === 0x0a &&
		buf[6] === 0x1a &&
		buf[7] === 0x0a
	)
		return true;
	// WebP: RIFF....WEBP
	if (
		buf[0] === 0x52 &&
		buf[1] === 0x49 &&
		buf[2] === 0x46 &&
		buf[3] === 0x46 &&
		buf[8] === 0x57 &&
		buf[9] === 0x45 &&
		buf[10] === 0x42 &&
		buf[11] === 0x50
	)
		return true;
	// TIFF: 49 49 2A 00 or 4D 4D 00 2A
	if (
		(buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
		(buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
	)
		return true;
	return false;
}

export async function processImage(input: Buffer): Promise<Buffer> {
	if (!hasValidImageMagicBytes(input)) {
		throw new Error('지원되지 않는 파일 형식이거나 손상된 이미지 파일입니다');
	}

	// OWASP ASVS V5.2.6: Pixel flood / Decompression bomb 방어 (최대 5천만 픽셀 제한)
	const instance = sharp(input, {
		failOn: 'error',
		limitInputPixels: MAX_INPUT_PIXELS
	});

	const meta = await instance.metadata();
	const allowedFormats = new Set(['jpeg', 'png', 'webp', 'tiff']);
	if (!meta.format || !allowedFormats.has(meta.format)) {
		throw new Error(`지원되지 않는 이미지 포맷입니다: ${meta.format ?? 'unknown'}`);
	}
	if (!meta.width || !meta.height || meta.width <= 0 || meta.height <= 0) {
		throw new Error('유효하지 않은 이미지 크기입니다');
	}

	// rotate(): EXIF 방향 보정. 폰 세로 촬영본이 옆으로 눕는 것을 막는다.
	const base = instance
		.rotate()
		.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
		.grayscale();

	return base.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

