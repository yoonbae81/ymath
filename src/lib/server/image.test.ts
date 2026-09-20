import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { IMAGE_FILE, MAX_SIDE, processImage } from './image';

/** 글씨처럼 흑백이 섞인 큰 이미지 */
const makePhoto = (w: number, h: number, orientation?: number) => {
	const img = sharp({ create: { width: w, height: h, channels: 3, background: '#f4f1ea' } }).composite([
		{
			input: Buffer.from(
				`<svg width="${w}" height="${h}"><text x="40" y="${h / 2}" font-size="120">x² − 5x + 6 = 0</text></svg>`
			)
		}
	]);
	return (orientation ? img.withMetadata({ orientation }) : img).jpeg().toBuffer();
};

describe('processImage', () => {
	it('저장하는 이미지는 하나이고 파일 이름은 image.jpg', () => {
		expect(IMAGE_FILE).toBe('image.jpg');
	});

	it('긴 변을 1600px 로 줄이고 작은 이미지는 키우지 않는다', async () => {
		const big = await processImage(await makePhoto(3000, 4000));
		const m = await sharp(big).metadata();
		expect(Math.max(m.width!, m.height!)).toBe(MAX_SIDE);

		const small = await processImage(await makePhoto(800, 600));
		expect((await sharp(small).metadata()).width).toBe(800);
	});

	it('그레이스케일 JPEG 로 저장한다', async () => {
		const out = await processImage(await makePhoto(2000, 1500));
		const m = await sharp(out).metadata();
		expect(m.format).toBe('jpeg');
		// 흑백 이미지는 세 채널의 값이 같다
		const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
		for (let i = 0; i < data.length; i += info.channels * 997) {
			expect(data[i]).toBe(data[i + 1]);
			expect(data[i]).toBe(data[i + 2]);
		}
	});

	it('원본 사진보다 작다', async () => {
		const photo = await makePhoto(3000, 4000);
		expect((await processImage(photo)).length).toBeLessThan(photo.length);
	});

	// 실제 사진에서 16색 디더링 PNG 가 JPEG 보다 2.6배 컸다. 노이즈가 있는 종이 사진에서 그 방식으로 되돌아가지 않도록 고정한다.
	it('종이 사진처럼 노이즈가 있는 입력에서도 디더링 PNG 보다 작다', async () => {
		const noisy = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#e9e6df', noise: { type: 'gaussian', mean: 233, sigma: 9 } } })
			.jpeg({ quality: 90 })
			.toBuffer();
		const jpeg = await processImage(noisy);
		const dithered = await sharp(noisy)
			.grayscale()
			.png({ palette: true, colours: 16, dither: 1.0 })
			.toBuffer();
		expect(jpeg.length).toBeLessThan(dithered.length);
	});

	it('EXIF 방향을 보정한다(세로 촬영본이 눕지 않음)', async () => {
		// 가로 400x200 픽셀 + orientation 6(시계 방향 90도) => 화면상 200x400
		const out = await processImage(await makePhoto(400, 200, 6));
		const m = await sharp(out).metadata();
		expect([m.width, m.height]).toEqual([200, 400]);
	});

	it('이미지가 아닌 입력은 예외', async () => {
		await expect(processImage(Buffer.from('not an image'))).rejects.toThrow();
	});
});
