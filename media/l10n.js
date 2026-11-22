// Tradução das páginas das views. O texto em português é a chave; quando a interface está em
// inglês, a extensão injeta o dicionário num bloco JSON (#launcher-l10n) antes dos scripts.
(function () {
	/** @type {Record<string, string>} */
	let dictionary = {};
	try {
		const node = document.getElementById('launcher-l10n');
		const parsed = node ? JSON.parse(node.textContent || '{}') : {};
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { dictionary = parsed; }
	} catch {
		dictionary = {};
	}

	/**
	 * @param {string} message
	 * @param {...(string | number)} args
	 */
	function t(message, ...args) {
		const known = Object.prototype.hasOwnProperty.call(dictionary, message) && typeof dictionary[message] === 'string';
		const template = known ? dictionary[message] : message;
		return args.length ? template.replace(/\{(\d+)\}/g, (match, index) => Number(index) < args.length ? String(args[Number(index)]) : match) : template;
	}

	window.launcherL10n = {
		t,
		/** `one` quando `count` é 1, senão `many`; os dois recebem `count` em `{0}`. */
		plural: (count, one, many) => t(count === 1 ? one : many, count),
		locale: (document.documentElement && document.documentElement.lang) || 'pt-BR',
	};
})();
