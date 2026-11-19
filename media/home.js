// View inicial do launcher: abrir o chat, abas de conversa abertas e conversas recentes.
(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');

	window.addEventListener('message', (event) => {
		if (event.data && event.data.type === 'state') {
			render(event.data);
		}
	});
	vscode.postMessage({ command: 'ready' });

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined && text !== null) {
			node.textContent = text;
		}
		return node;
	}

	function send(command, extra) {
		vscode.postMessage(Object.assign({ command }, extra || {}));
	}

	function button(label, className, command, extra, title) {
		const node = el('button', className, label);
		node.type = 'button';
		if (title) {
			node.title = title;
		}
		node.addEventListener('click', (event) => {
			event.stopPropagation();
			send(command, extra);
		});
		return node;
	}

	function render(state) {
		root.replaceChildren();
		if (state.coverageMessage) {
			root.append(el('p', 'muted', state.coverageMessage));
		}

		if (!state.installed) {
			root.append(el('p', 'warning', 'A extensão oficial Claude Code não está instalada. O chat vem dela.'));
			root.append(button('Instalar Claude Code', 'primary wide', 'install'));
			return;
		}

		const actions = el('div', 'actions');
		actions.append(button('+ Nova conversa em aba', 'primary', 'newTab', null, 'Abre uma conversa nova numa aba do editor'));
		root.append(actions);

		root.append(renderOpenTabs(state.openTabs));
		root.append(renderRecent(state));
	}

	function renderOpenTabs(tabs) {
		const section = el('section');
		section.append(el('h2', null, 'Abas abertas' + (tabs.length ? ' (' + tabs.length + ')' : '')));
		if (tabs.length === 0) {
			section.append(el('p', 'muted', 'Nenhuma conversa aberta em aba.'));
			return section;
		}
		const list = el('ul', 'list');
		for (const tab of tabs) {
			const item = el('li', 'item' + (tab.active ? ' active' : ''));
			item.title = 'Ir para esta aba';
			item.addEventListener('click', () => send('focusTab', { key: tab.key }));
			const text = el('div', 'item-text');
			text.append(el('span', 'item-title', tab.label));
			item.append(el('span', 'icon', tab.active ? '●' : '○'), text);
			item.append(button('×', 'icon-button', 'closeTab', { key: tab.key }, 'Fechar esta aba'));
			list.append(item);
		}
		section.append(list);
		return section;
	}

	function renderRecent(state) {
		const section = el('section');
		const header = el('div', 'section-head');
		header.append(el('h2', null, 'Conversas recentes'));
		header.append(button('↻', 'icon-button', 'refresh', null, 'Atualizar a lista'));
		section.append(header);

		if (!state.hasFolder) {
			section.append(el('p', 'muted', 'Abra uma pasta de projeto para ver as conversas dela.'));
			return section;
		}
		if (state.sessions.length === 0) {
			section.append(el('p', 'muted', 'Nenhuma conversa do Claude Code neste projeto ainda.'));
			return section;
		}
		const list = el('ul', 'list');
		for (const session of state.sessions) {
			const item = el('li', 'item' + (session.open ? ' open' : ''));
			item.title = session.open ? 'Já está aberta: ir para a aba' : 'Abrir esta conversa numa aba';
			item.addEventListener('click', () => send('openSession', { id: session.id }));
			const text = el('div', 'item-text');
			text.append(el('span', 'item-title', session.title));
			text.append(el('span', 'item-meta', relativeTime(session.updated) + (session.open ? ' · aberta' : '')));
			item.append(el('span', 'icon', '💬'), text);
			list.append(item);
		}
		section.append(list);
		return section;
	}

	function relativeTime(ms) {
		const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (seconds < 60) {
			return 'agora';
		}
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) {
			return 'há ' + minutes + ' min';
		}
		const hours = Math.round(minutes / 60);
		if (hours < 24) {
			return 'há ' + hours + ' h';
		}
		const days = Math.round(hours / 24);
		if (days < 7) {
			return days === 1 ? 'ontem' : 'há ' + days + ' dias';
		}
		return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
	}
})();
