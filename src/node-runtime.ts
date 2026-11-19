/** Procura um executável no PATH como um spawn sem shell faria. Não cria processos. */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ExecutableLookup {
	env: Record<string, string | undefined>;
	platform: string;
	/** Ponto de injeção para testes; o padrão consulta o sistema de arquivos. */
	isExecutable?: (file: string) => Promise<boolean>;
}

async function executableFile(file: string): Promise<boolean> {
	try {
		if (!(await fs.promises.stat(file)).isFile()) { return false; }
		await fs.promises.access(file, fs.constants.X_OK);
		return true;
	} catch { return false; }
}

/**
 * Caminho do primeiro `name` encontrado no PATH, ou undefined. Entradas relativas do PATH são
 * ignoradas: dependeriam do diretório atual, que aqui pode ser a pasta do projeto.
 */
export async function findExecutable(name: string, options: ExecutableLookup): Promise<string | undefined> {
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) { return undefined; }
	const windows = options.platform === 'win32', paths = windows ? path.win32 : path.posix;
	const variable = windows ? Object.keys(options.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH' : 'PATH';
	const directories = (options.env[variable] ?? '').split(windows ? ';' : ':')
		.filter((directory) => directory.length > 0 && directory.length <= 4096 && paths.isAbsolute(directory)).slice(0, 256);
	const extensions = windows ? (options.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).slice(0, 32) : [''];
	const check = options.isExecutable ?? executableFile;
	for (const directory of directories) {
		for (const extension of extensions) {
			const candidate = paths.join(directory, name + extension);
			if (await check(candidate)) { return candidate; }
		}
	}
	return undefined;
}
