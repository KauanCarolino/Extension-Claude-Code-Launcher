// Calibração local: o teste, não o modelo, diz se a confiança declarada merece o caminho barato.
// Fica em `~/.orquestra/calibration.json` e nunca vai para o repositório.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const BASE_THRESHOLD = 0.75;
export const BAND_WIDTH = 0.2;
export const MIN_ATTEMPTS = 8;
export const MIN_SUCCESS_RATE = 0.6;

export interface Band {
	attempts: number;
	firstPass: number;
}

export interface Calibration {
	version: 1;
	/** Chave é o início da faixa, `"0.6"` para [0,6; 0,8). */
	bands: Record<string, Band>;
}

export function homeDir(): string {
	return process.env.ORQUESTRA_HOME || path.join(os.homedir(), '.orquestra');
}

export function calibrationFile(): string {
	return path.join(homeDir(), 'calibration.json');
}

export function bandKey(confidence: number): string {
	const c = Math.min(Math.max(confidence, 0), 1);
	// 1,0 cai na última faixa, não numa sexta.
	const index = Math.min(Math.floor(c / BAND_WIDTH + 1e-9), Math.round(1 / BAND_WIDTH) - 1);
	return (index * BAND_WIDTH).toFixed(1);
}

export function loadCalibration(file = calibrationFile()): Calibration {
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Calibration;
		if (raw && raw.version === 1 && raw.bands && typeof raw.bands === 'object') return raw;
	} catch {}
	return { version: 1, bands: {} };
}

export function saveCalibration(cal: Calibration, file = calibrationFile()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(cal, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

/** Registra o resultado da primeira rodada de teste para cada confiança declarada na tarefa. */
export function recordOutcome(cal: Calibration, confidences: number[], firstPass: boolean): Calibration {
	for (const c of confidences) {
		const key = bandKey(c);
		const band = cal.bands[key] ?? { attempts: 0, firstPass: 0 };
		band.attempts += 1;
		if (firstPass) band.firstPass += 1;
		cal.bands[key] = band;
	}
	return cal;
}

/** Faixa com histórico suficiente e acerto abaixo de 60% é tratada como baixa, diga o modelo o que disser. */
export function bandIsDemoted(cal: Calibration, confidence: number): boolean {
	const band = cal.bands[bandKey(confidence)];
	if (!band || band.attempts < MIN_ATTEMPTS) return false;
	return band.firstPass / band.attempts < MIN_SUCCESS_RATE;
}

export function isConfident(cal: Calibration, confidence: number, threshold = BASE_THRESHOLD): boolean {
	return confidence >= threshold && !bandIsDemoted(cal, confidence);
}
