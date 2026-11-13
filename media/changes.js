// Painel "Mudanças do Claude". Monta tudo com textContent: nenhum texto vindo
// dos arquivos ou do Claude é interpretado como HTML.
(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('root');
	const openCards = new Set();
	let firstRender = true;

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

	function button(label, command, extra, className) {
		const node = el('button', className || 'secondary', label);
		node.type = 'button';
		node.addEventListener('click', (event) => {
			event.stopPropagation();
			vscode.postMessage(Object.assign({ command }, extra || {}));
		});
		return node;
	}

	function render(state) {
		document.body.classList.toggle('wide', Boolean(state.wide));
		root.replaceChildren();
		root.append(renderToolbar(state));

		if (!state.hasFolder) {
			root.append(el('p', 'muted', 'Abra uma pasta de projeto para registrar as mudanças do Claude.'));
			return;
		}
		if (!state.enabled) {
			root.append(renderIntro());
		}
		if (state.files && state.files.length > 0) {
			root.append(renderFiles(state));
		} else if (state.entries.length > 0) {
			root.append(el('p', 'muted all-reviewed', '✓ Nada para revisar: todas as mudanças do Claude já foram aceitas ou recusadas.'));
		}
		root.append(renderLegend());

		if (state.entries.length === 0) {
			root.append(el('p', 'muted empty', state.enabled
				? 'Nenhuma mudança registrada ainda. Peça ao Claude para editar um arquivo e ela aparece aqui.'
				: 'Nada registrado.'));
			return;
		}

		if (firstRender) {
			openCards.add(state.entries[0].id);
			firstRender = false;
		}
		let lastDay = '';
		let group = null;
		for (const entry of state.entries) {
			const day = dayLabel(entry.time);
			if (day !== lastDay) {
				root.append(el('div', 'day', day));
				lastDay = day;
				group = null;
			}
			if (!entry.requestId) {
				group = null;
				root.append(renderEntry(entry));
				continue;
			}
			if (!group || group.id !== entry.requestId) {
				group = { id: entry.requestId, box: renderRequest(entry, state.entries) };
				root.append(group.box);
			}
			group.box.append(renderEntry(entry));
		}
	}

	// Agrupa as edições feitas para atender a mesma mensagem do usuário.
	function renderRequest(entry, entries) {
		const same = entries.filter((item) => item.requestId === entry.requestId);
		const files = new Set(same.map((item) => (item.dir ? item.dir + '/' : '') + item.file));
		const box = el('div', 'request');
		const head = el('div', 'request-head');
		const text = el('div', 'request-text');
		text.append(el('span', 'request-label', 'Pedido'));
		text.append(el('span', 'request-quote', entry.request));
		head.append(text);
		const meta = el('div', 'request-meta');
		meta.append(el('span', 'muted', files.size === 1 ? '1 arquivo' : files.size + ' arquivos'));
		if (same.some((item) => item.status !== 'rejected')) {
			const undo = button('Desfazer pedido', 'rejectRequest', { request: entry.requestId }, 'secondary small');
			undo.title = 'Volta os arquivos deste pedido para como eram antes dele';
			meta.append(undo);
		}
		head.append(meta);
		box.append(head);
		return box;
	}

	function renderToolbar(state) {
		const bar = el('div', 'toolbar');
		const status = el('span', state.enabled ? 'status on' : 'status off',
			state.enabled ? '● Registrando' : '○ Registro desligado');
		bar.append(status);
		const actions = el('div', 'actions');
		if (state.canUndo) {
			const undo = button('↶ Desfazer recusa', 'undoReject', null, 'primary');
			undo.title = 'Traz de volta as mudanças do Claude que você acabou de recusar';
			actions.append(undo);
		}
		actions.append(button('Atualizar', 'refresh'));
		if (!state.wide) {
			actions.append(button('Tela maior', 'openPanel'));
		}
		if (state.entries.length > 0) {
			actions.append(button('Limpar', 'clear'));
		}
		if (state.hasFolder) {
			actions.append(state.enabled ? button('Desligar', 'disable') : button('Ativar', 'enable', null, 'primary'));
		}
		bar.append(actions);
		return bar;
	}

	let filesOpen = true;

	// Resumo por arquivo: "N arquivos", cada um com +linhas / −linhas.
	function renderFiles(state) {
		const box = el('details', 'files');
		box.open = filesOpen;
		box.addEventListener('toggle', () => {
			filesOpen = box.open;
		});

		const head = el('summary', 'files-head');
		const count = state.files.length;
		head.append(el('span', 'files-count', (count === 1 ? '1 arquivo' : count + ' arquivos') + ' para revisar'));
		const headActions = el('span', 'files-actions');
		const accept = button('✓ Aceitar todos', 'acceptAll', null, 'secondary review accept');
		accept.title = 'Mantém tudo como o Claude deixou e tira os arquivos desta lista';
		const reject = button('✕ Recusar todos', 'rejectAll', null, 'secondary review reject');
		reject.title = 'Volta cada arquivo para como era antes do Claude editar';
		headActions.append(accept, reject);
		if (!state.wide) {
			headActions.append(button('Revisar', 'openPanel', null, 'secondary review'));
		}
		head.append(headActions);
		box.append(head);

		const list = el('div', 'files-list');
		for (const file of state.files) {
			const row = el('div', 'file-row');
			const main = el('button', 'file-main');
			main.type = 'button';
			main.title = (file.dir ? file.dir + '/' : '') + file.file + '\nClique para ver a mudança no código';
			main.addEventListener('click', () => {
				vscode.postMessage({ command: file.deleted ? 'openFile' : 'showInCode', id: file.id });
			});
			const icon = fileIcon(file.file);
			main.append(el('span', 'file-icon ' + icon.className, icon.text));
			main.append(el('span', 'file-name' + (file.deleted ? ' gone' : ''), file.file));
			if (file.created) {
				main.append(el('span', 'file-tag', 'novo'));
			}
			const stats = el('span', 'file-stats');
			if (file.added) {
				stats.append(el('span', 'stat add', '+' + file.added));
			}
			if (file.removed) {
				stats.append(el('span', 'stat del', '−' + file.removed));
			}
			main.append(stats);
			row.append(main);

			const rowActions = el('span', 'file-actions');
			const accept = button('✓', 'acceptFile', { key: file.key }, 'icon accept');
			accept.title = 'Aceitar as mudanças neste arquivo';
			accept.setAttribute('aria-label', 'Aceitar ' + file.file);
			const reject = button('✕', 'rejectFile', { key: file.key }, 'icon reject');
			reject.title = 'Recusar: volta este arquivo para como era antes do Claude';
			reject.setAttribute('aria-label', 'Recusar ' + file.file);
			rowActions.append(accept, reject);
			row.append(rowActions);
			list.append(row);
		}
		box.append(list);
		return box;
	}

	function fileIcon(name) {
		const lower = name.toLowerCase();
		const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
		const icons = {
			ts: ['TS', 'ts'], tsx: ['TS', 'ts'], js: ['JS', 'js'], jsx: ['JS', 'js'], mjs: ['JS', 'js'], cjs: ['JS', 'js'],
			json: ['{}', 'json'], jsonc: ['{}', 'json'], md: ['ⓘ', 'md'], css: ['#', 'css'], scss: ['#', 'css'],
			html: ['<>', 'html'], svg: ['◆', 'svg'], py: ['py', 'py'],
		};
		const found = icons[ext] || (lower.startsWith('.') ? ['◆', 'dot'] : ['•', 'other']);
		return { text: found[0], className: found[1] };
	}

	function renderIntro() {
		const box = el('div', 'intro');
		box.append(el('p', null,
			'Ative o registro para guardar cada arquivo que o Claude editar: o que saiu, o que entrou e o motivo que ele deu.'));
		box.append(el('p', 'muted',
			'Isso adiciona um hook em .claude/settings.local.json deste projeto. Vale para conversas iniciadas depois de ativar.'));
		box.append(button('Ativar registro de mudanças', 'enable', null, 'primary'));
		return box;
	}

	function renderLegend() {
		const details = el('details', 'legend');
		details.append(el('summary', null, 'Como ler as mudanças'));
		const list = el('ul');
		const items = [
			['row add', '+', 'Linha nova: não existia antes.'],
			['row del', '−', 'Linha removida: existia e foi apagada.'],
			['row del paired', '−', 'Linha modificada, versão de antes. O destaque forte mostra as palavras que saíram.'],
			['row add paired', '+', 'Linha modificada, versão de depois. O destaque forte mostra as palavras que entraram.'],
			['row ctx', ' ', 'Linha sem mudança, mostrada só para dar contexto.'],
		];
		for (const [className, sign, text] of items) {
			const item = el('li');
			const sample = el('span', className + ' sample');
			sample.append(el('span', 'sign', sign));
			item.append(sample, el('span', null, text));
			list.append(item);
		}
		details.append(list);
		return details;
	}

	function renderEntry(entry) {
		const card = el('details', 'card');
		card.open = openCards.has(entry.id);
		card.addEventListener('toggle', () => {
			if (card.open) {
				openCards.add(entry.id);
			} else {
				openCards.delete(entry.id);
			}
		});

		const head = el('summary', 'card-head');
		const title = el('div', 'title');
		title.append(el('span', 'badge ' + badgeClass(entry.action), entry.action));
		title.append(el('span', 'file', entry.file));
		if (entry.status === 'accepted') {
			title.append(el('span', 'status-tag accepted', 'aceita'));
		} else if (entry.status === 'rejected') {
			title.append(el('span', 'status-tag rejected', 'recusada'));
		}
		head.append(title);
		const meta = el('div', 'meta');
		meta.append(el('span', 'time', timeLabel(entry.time)));
		meta.append(renderStats(entry));
		head.append(meta);
		card.append(head);

		const body = el('div', 'card-body');
		if (entry.dir) {
			body.append(el('div', 'dir', entry.dir + '/'));
		}
		body.append(el('p', 'summary', entry.summary));

		if (entry.reason) {
			const reason = el('div', 'reason');
			reason.append(el('div', 'reason-title', 'O que o Claude disse antes de editar'));
			reason.append(el('div', 'reason-text', entry.reason));
			body.append(reason);
		}
		if (entry.note) {
			body.append(el('p', 'note', entry.note));
		}

		entry.hunks.forEach((hunk, index) => body.append(renderHunk(hunk, index, entry.hunks.length)));

		const actions = el('div', 'card-actions');
		if (entry.canCompare) {
			actions.append(button('Ver no código', 'showInCode', { id: entry.id }, 'primary'));
			actions.append(button('Lado a lado', 'compare', { id: entry.id }));
		} else {
			actions.append(button('Abrir arquivo', 'openFile', { id: entry.id }));
		}
		body.append(actions);
		card.append(body);
		return card;
	}

	function renderStats(entry) {
		const stats = el('span', 'stats');
		if (entry.added) {
			stats.append(el('span', 'stat add', '+' + entry.added));
		}
		if (entry.removed) {
			stats.append(el('span', 'stat del', '−' + entry.removed));
		}
		if (entry.modified) {
			stats.append(el('span', 'stat mod', '~' + entry.modified));
		}
		return stats;
	}

	function renderHunk(hunk, index, total) {
		const box = el('div', 'hunk');
		const label = total > 1 ? 'Trecho ' + (index + 1) + ' de ' + total : 'Trecho alterado';
		box.append(el('div', 'hunk-title', hunk.label ? label + ' · ' + hunk.label : label));
		const code = el('div', 'code');
		for (const line of hunk.lines) {
			code.append(renderLine(line));
		}
		box.append(code);
		return box;
	}

	function renderLine(line) {
		const row = el('div', 'row ' + line.kind + (line.pair ? ' paired' : ''));
		const number = line.kind === 'del' ? line.oldNo : line.newNo;
		row.append(el('span', 'no', number === undefined ? '' : String(number)));
		row.append(el('span', 'sign', line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '));
		const text = el('span', 'text');
		if (line.segments) {
			for (const segment of line.segments) {
				text.append(el('span', segment.changed ? 'word' : null, segment.text));
			}
		} else {
			text.textContent = line.text === '' ? ' ' : line.text;
		}
		row.append(text);
		if (line.pair) {
			row.append(el('span', 'tag', line.pair));
		}
		return row;
	}

	function badgeClass(action) {
		if (action === 'Criou') {
			return 'create';
		}
		if (action === 'Reescreveu') {
			return 'rewrite';
		}
		return 'edit';
	}

	function timeLabel(iso) {
		const date = new Date(iso);
		return isNaN(date.getTime()) ? '' : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
			return 'Hoje';
		}
		if (date.toDateString() === yesterday.toDateString()) {
			return 'Ontem';
		}
		return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
	}
})();
