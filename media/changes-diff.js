// Linhas de diff do painel "Mudanças do Claude", no modo unificado e lado a lado. Monta tudo com
// textContent: nenhum texto vindo dos arquivos é interpretado como HTML.
// Carregado depois de l10n.js e antes de changes.js.
(function () {
	const { t } = window.launcherL10n;

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

	function renderLine(line) {
		const row = el('div', 'row ' + line.kind + (line.pair ? ' paired' : ''));
		const number = line.kind === 'del' ? line.oldNo : line.newNo;
		row.append(el('span', 'no', number === undefined ? '' : String(number)));
		row.append(el('span', 'sign', signOf(line.kind)));
		row.append(lineText(line));
		if (line.pair) {
			row.append(el('span', 'tag', line.pair === 'antes' ? t('antes') : t('depois')));
		}
		return row;
	}

	/** Junta cada bloco de linhas removidas com o de linhas novas, lado a lado. */
	function splitRows(lines) {
		const rows = [];
		let index = 0;
		while (index < lines.length) {
			if (lines[index].kind === 'ctx') {
				rows.push([lines[index], lines[index]]);
				index += 1;
				continue;
			}
			const dels = [];
			const adds = [];
			while (index < lines.length && lines[index].kind !== 'ctx') {
				(lines[index].kind === 'del' ? dels : adds).push(lines[index]);
				index += 1;
			}
			for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
				rows.push([dels[k] || null, adds[k] || null]);
			}
		}
		return rows;
	}

	function renderSplitRow(pair) {
		const row = el('div', 'split-row');
		row.append(splitCell(pair[0], 'oldNo'), splitCell(pair[1], 'newNo'));
		return row;
	}

	function splitCell(line, numberField) {
		if (!line) {
			const empty = el('div', 'row filler');
			empty.append(el('span', 'no'), el('span', 'sign'), el('span', 'text'));
			return empty;
		}
		const cell = el('div', 'row ' + line.kind + (line.pair ? ' paired' : ''));
		const number = line[numberField];
		cell.append(el('span', 'no', number === undefined ? '' : String(number)));
		cell.append(el('span', 'sign', signOf(line.kind)));
		cell.append(lineText(line));
		return cell;
	}

	function lineText(line) {
		const text = el('span', 'text');
		if (line.segments) {
			for (const segment of line.segments) {
				text.append(el('span', segment.changed ? 'word' : null, segment.text));
			}
		} else {
			text.textContent = line.text === '' ? ' ' : line.text;
		}
		return text;
	}

	function signOf(kind) {
		return kind === 'add' ? '+' : kind === 'del' ? '−' : ' ';
	}

	window.launcherDiff = { renderLine, renderSplitRow, splitRows };
})();
