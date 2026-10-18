import { openai } from 'inngest';
import { buildOcrMessages, markdownFromOcrResponse } from '../ocr-core';
import { validateInferenceConfig } from './inference';
import { OCR_PROBE_IMAGE_MARKER, OCR_PROBE_JPEG_BASE64 } from './ocr-probe-fixture';
import type { SliceEnv } from './app';
import type { createSliceStore, SliceJob } from './store';

export interface OcrProbeStep {
	run<T>(id: string, callback: () => T | Promise<T>): Promise<T>;
	ai: { infer(id: string, options: { model: ReturnType<typeof openai>; body: { messages: ReturnType<typeof buildOcrMessages>; max_tokens?: number; temperature?: number; stream?: boolean }; timeout?: string }): Promise<unknown> };
}

/** Fixed image-only probe; never put the expected image marker in the text prompt. */
export async function runOcrProbe(store: ReturnType<typeof createSliceStore>, env: SliceEnv, job: SliceJob, step: OcrProbeStep) {
	if (!env.OBJECTS) throw new Error('R2 OBJECTS binding is required for OCR probe');
	const objects = env.OBJECTS;
	const model = 'PaddleOCR-VL-1.6-mlx';
	const config = validateInferenceConfig({ ...env, LLM_MODEL: model });
	const started = await step.run('ocr-probe-infer-start', () => Date.now());
	// The SDK forwards extra infer options into the AIGateway operation.
	const response = await step.ai.infer('infer-ocr-probe', {
		model: openai(config), timeout: '2m',
		body: { messages: buildOcrMessages(OCR_PROBE_JPEG_BASE64), max_tokens: 8192, temperature: 0, stream: false }
	});
	const ended = await step.run('ocr-probe-infer-end', () => Date.now());
	const envelope = response as { error?: unknown; choices?: Array<{ finish_reason?: unknown }> } | null;
	if (!envelope || envelope.error || envelope.choices?.length !== 1 || envelope.choices[0].finish_reason !== 'stop') throw new Error('OCR probe response is invalid or incomplete');
	const ocrText = markdownFromOcrResponse(response);
	const imageMarkerMatched = ocrText.includes(OCR_PROBE_IMAGE_MARKER);
	const ocrKey = `probes/${job.id}/ocr.txt`;
	await step.run('store-ocr-probe-text', () => objects.put(ocrKey, new TextEncoder().encode(ocrText), { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }));
	const persistedReadback = await step.run('readback-ocr-probe-text', async () => {
		const object = await objects.get(ocrKey);
		return object !== null && await new Response(object.body).text() === ocrText;
	});
	const result = { imageMarkerMatched, ocrText, ocrKey, persistedReadback, inferObservedMs: ended - started, model };
	const saved = await step.run('validate-and-save-result', () => store.complete(job, JSON.stringify(result)));
	return { status: !saved ? 'stale_result_rejected' : imageMarkerMatched && persistedReadback ? 'done' : 'probe_failed' };
}
