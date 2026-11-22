// Regras de correção, não de estilo: o que aqui falha costuma ser defeito de verdade.
import tseslint from 'typescript-eslint';

/** Regras comuns aos scripts JavaScript que vão no pacote (hook e páginas das views). */
const javascriptRules = {
	'no-undef': 'error',
	'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
	'no-redeclare': 'error',
	'no-dupe-keys': 'error',
	'no-duplicate-case': 'error',
	'no-fallthrough': 'error',
	'no-unreachable': 'error',
	'no-self-assign': 'error',
	'no-cond-assign': 'error',
	'no-constant-condition': ['error', { checkLoops: false }],
	'no-empty': ['error', { allowEmptyCatch: true }],
	'no-eval': 'error',
	'no-implied-eval': 'error',
	'no-new-func': 'error',
	'no-prototype-builtins': 'error',
	'use-isnan': 'error',
	'valid-typeof': 'error',
	eqeqeq: ['error', 'always'],
	'no-var': 'error',
	'prefer-const': 'error',
	'no-throw-literal': 'error',
	'no-unsafe-finally': 'error',
};

const readonly = (names) => Object.fromEntries(names.map((name) => [name, 'readonly']));

export default tseslint.config(
	{ ignores: ['out/**', 'node_modules/**', 'scripts/**', 'test/**', 'docs/**', 'types/**', '.claude/**'] },
	{
		files: ['src/**/*.ts'],
		languageOptions: { parser: tseslint.parser, parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
		plugins: { '@typescript-eslint': tseslint.plugin },
		rules: {
			// Uma promessa esquecida esconde a falha e a ordem dos efeitos.
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/no-unnecessary-type-assertion': 'error',
			'@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
			'@typescript-eslint/no-for-in-array': 'error',
			'@typescript-eslint/no-implied-eval': 'error',
			eqeqeq: ['error', 'always'],
			'no-var': 'error',
			'prefer-const': 'error',
			'no-throw-literal': 'error',
			'no-unsafe-finally': 'error',
		},
	},
	{
		// O hook roda a cada edição do Claude, fora do editor: é o código mais sensível do pacote.
		files: ['hooks/**/*.js'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'commonjs',
			globals: readonly(['require', 'module', 'exports', 'process', 'Buffer', '__dirname', '__filename', 'console', 'setTimeout', 'clearTimeout']),
		},
		rules: javascriptRules,
	},
	{
		files: ['media/**/*.js'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'script',
			globals: readonly(['window', 'document', 'acquireVsCodeApi', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Event', 'console']),
		},
		rules: javascriptRules,
	},
);
