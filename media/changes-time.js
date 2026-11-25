// Datas do painel "Mudanças do Claude": rótulos relativos ("há 5 min"), curtos e exatos.
// Carregado depois de l10n.js e antes de changes.js.
(function () {
	const { t, locale } = window.launcherL10n;

	/** Tempo curto, para caber no fim da linha: "agora", "5 min", "3 h" ou a hora. */
	function shortTime(iso) {
		const ms = new Date(iso).getTime();
		if (isNaN(ms)) {
			return '';
		}
		const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
		if (minutes < 1) {
			return t('agora');
		}
		if (minutes < 60) {
			return t('{0} min', minutes);
		}
		const hours = Math.round(minutes / 60);
		if (hours < 24) {
			return t('{0} h', hours);
		}
		return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
	}

	function relativeLabel(iso) {
		const ms = new Date(iso).getTime();
		if (isNaN(ms)) {
			return '';
		}
		const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (seconds < 60) {
			return t('agora');
		}
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) {
			return t('há {0} min', minutes);
		}
		const hours = Math.round(minutes / 60);
		if (hours < 24) {
			return t('há {0} h', hours);
		}
		return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
	}

	function exactLabel(iso) {
		const date = new Date(iso);
		return isNaN(date.getTime()) ? '' : date.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'medium' });
	}

	function dayLabel(iso) {
		const date = new Date(iso);
		if (isNaN(date.getTime())) {
			return '';
		}
		const today = new Date();
		const yesterday = new Date();
		yesterday.setDate(today.getDate() - 1);
		if (date.toDateString() === today.toDateString()) {
			return t('Hoje');
		}
		if (date.toDateString() === yesterday.toDateString()) {
			return t('Ontem');
		}
		return date.toLocaleDateString(locale, { day: '2-digit', month: 'long', year: 'numeric' });
	}

	window.launcherTime = { shortTime, relativeLabel, exactLabel, dayLabel };
})();
