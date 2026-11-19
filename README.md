# Claude Code Launcher

Extensão para Cursor e Visual Studio Code que abre o chat oficial do Claude Code e permite revisar as mudanças dele no painel e no editor.

O chat, a autenticação, os modelos e as permissões pertencem à extensão oficial **Claude Code** (`anthropic.claude-code`). O launcher usa essa integração; não incorpora o Agent do Cursor.

Versão: **0.8.0**. Pacote local: `claude-code-launcher-0.8.0.vsix`.

## Requisitos e compatibilidade

- Visual Studio Code **1.94.0 ou superior**. No Cursor, a API do editor precisa ser compatível; a combinação validada está na tabela abaixo.
- Extensão oficial Claude Code para abrir conversas. A instalação só ocorre quando você escolhe **Instalar**.
- Workspace confiável e arquivos locais para a revisão e a captura. O launcher fica desabilitado no Restricted Mode.
- Node.js **22 ou superior** no `PATH` para o fluxo de desenvolvimento e para executar o hook local. O Node embutido no Extension Host é independente do Node do terminal.

| Editor | Validação local de revisão |
| --- | --- |
| VS Code 1.94.0, Node do host 20.16.0 | macOS arm64 |
| VS Code 1.146.0, Node do host 24.22.1 | macOS arm64 |
| Cursor 3.19.13, API VS Code 1.128.0, Node do host 24.18.1 | macOS arm64 |

As jornadas cobrem ativação, comandos, preservação das preferências com gestão desligada, CRLF, recusa de criação, desfazer, revisão parcial e edição humana entre capturas. Os testes de adaptadores cobrem falhas de gravação, recuperação e concorrência. Abertura autenticada de conversas, Windows/Linux, hosts remotos, providers virtuais e notebooks não têm a mesma validação de host. A revisão de recursos não admitidos bloqueia alterações de conteúdo.

A compatibilidade de hooks é verificada separadamente: o modo automático exige que o schema da extensão oficial selecionada declare `command` com `args` separados. Não se presume uma versão mínima do Claude a partir dessa capacidade. Consulte o [contrato oficial dos hooks](https://code.claude.com/docs/en/hooks#command-hook-fields).

## Instalação

1. Em **Extensions**, abra o menu `…` e escolha **Install from VSIX**.
2. Selecione `claude-code-launcher-0.8.0.vsix`.
3. Abra a pasta do projeto e use um comando da categoria **Claude Code Launcher**.
4. Para registrar novas mudanças, use **Ativar registro de mudanças** e inicie uma nova conversa do Claude.

Atualizar o pacote não publica a extensão nem envia o histórico para um serviço externo. Os dados locais podem conter código e trechos de conversas; consulte a política de armazenamento abaixo.

## Abrir e organizar conversas

O ícone de balão no título do editor e o item **Claude** na barra de status abrem a barra lateral oficial. **Nova conversa em aba** e **Abrir chat em nova aba** usam o editor de conversas do Claude. A view **Claude Code** lista as abas abertas e até 15 conversas recentes das pastas locais do workspace; permite retomar, focar e fechar abas.

Os títulos vêm de `~/.claude/projects/`, ou de `CLAUDE_CONFIG_DIR` quando definido. A leitura é assíncrona, usa cache limitado e mostra um aviso quando a lista está parcial. Resultados de uma view já fechada são descartados.

O launcher informa quando a extensão oficial está ausente, a ativação demora, o comando não está disponível ou a abertura da aba não é confirmada. Um erro de autenticação informado pelo Claude orienta a fazer login. O launcher não possui uma API pública para consultar o estado de login; uma aba já aberta não comprova que uma nova conversa abriu. Quando necessário, o endereço de abertura usa o protocolo do editor atual, inclusive `cursor://`.

A organização automática dos grupos vem **desligada**. Ative `claudeCodeLauncher.manageEditorGroups` se quiser separar arquivos do grupo do chat e gerir as preferências de abertura. Ao desligar, somente valores ainda pertencentes à extensão são restaurados. Uma alteração manual posterior encerra a gestão daquele valor até desligar e ligar a opção novamente. Outro workspace com a opção desligada não restaura as preferências geridas pelo workspace atual.

## Revisar mudanças

A view **Mudanças** reúne edições capturadas pelas ferramentas Edit, Write, MultiEdit e NotebookEdit. Capturar um evento de notebook não significa que a reversão dele esteja habilitada.

O bloco de arquivos pendentes oferece aceitar, recusar e abrir a revisão no código. Os cards mostram o histórico de cada edição, seu resumo e, quando disponível, o pedido e a explicação encontrados no transcript. **Tela maior** abre o mesmo painel em uma aba.

- **Aceitar** mantém o conteúdo e registra a decisão. Aceitar um trecho incorpora somente aquele trecho à base da revisão.
- **Recusar** restaura somente a parte ainda pendente. Uma parte aceita no editor continua aceita ao usar o painel ou recarregar a janela.
- Uma revisão com partes aceitas e recusadas recebe estado **misto**. Edições contínuas abrangidas pela decisão têm todos os seus IDs representados.
- Edições humanas, mudanças externas, identidade ambígua e snapshots insuficientes estabelecem barreiras. A ação pode ficar bloqueada ou atingir apenas o segmento contínuo comprovado; o launcher não volta através de uma edição humana para completar o lote.
- Recusar um arquivo criado restaura sua **ausência**. Arquivo vazio e arquivo inexistente são situações diferentes. Exclusões usam a lixeira; uma falha não provoca tentativa de exclusão permanente.
- A decisão que altera conteúdo só é concluída depois de aplicar, salvar e verificar o resultado. Uma falha de salvamento não aparece como recusa concluída.
- **Desfazer a última recusa** usa recuperação persistida por item. Itens conflitantes continuam recuperáveis e não são consumidos como se tivessem sido restaurados. Uma intenção interrompida pode exigir reconciliação antes de uma nova ação.

As lentes oferecem **Aceitar** e **Recusar** por trecho. Quando há vários trechos, também oferecem aceitar ou recusar tudo. O comando **Ocultar marcas** aceita as mudanças pendentes daquele arquivo; para ocultar somente a apresentação, desligue `claudeCodeLauncher.inlineChanges`.

**Lado a lado** nas lentes compara a base da revisão atual, incluindo decisões parciais, com o arquivo observado. A comparação de um card mostra o antes/depois histórico daquela edição. Essas comparações respondem a perguntas diferentes.

Arquivos pendentes recebem a letra **C** no Explorer e uma contagem na barra de status. `Alt+]` e `Alt+[` percorrem os trechos. Cores podem ser ajustadas pelo tema, incluindo `claudeCodeLauncher.pendingChangeForeground`.

## Hooks e dados locais

Ativar o registro configura handlers próprios em `.claude/settings.local.json` e copia o script para `.claude/launcher-changes/`. O comando do hook usa executável e argumentos separados. Grupos mistos mantêm os handlers de terceiros; JSON inválido ou uma alteração concorrente bloqueiam a atualização da configuração.

O modo `auto` exige capacidade comprovada no schema. `exec` é uma escolha explícita para um harness que você verificou suportar esse formato. `disabled` desliga os hooks geridos. Não existe fallback automático por shell. O hook observa a edição; uma falha de captura não autoriza nem impede a operação original do Claude.

O histórico contém cópias locais em texto, sem criptografia própria. As exclusões padrão evitam novas cópias de `.env`, chaves privadas, certificados e alguns arquivos de credenciais. Mudar uma exclusão não apaga cópias antigas nem garante que todo segredo possível seja reconhecido. Arquivos acima de **512 KiB** não têm o conteúdo integral capturado.

| Configuração | Padrão | Efeito |
| --- | --- | --- |
| `claudeCodeLauncher.inlineChanges` | `true` | Mostra as marcas de revisão |
| `claudeCodeLauncher.manageEditorGroups` | `false` | Permite gestão de grupos e preferências |
| `claudeCodeLauncher.hookExecutionMode` | `auto` | `auto`, `exec` ou `disabled` |
| `claudeCodeLauncher.historyExcludedPatterns` | Padrões de arquivos sensíveis | Exclusões de novas cópias; aceita `*`, `**` e `?` |
| `claudeCodeLauncher.historyRetentionDays` | `30` | Retenção de histórico revisado; `0` desliga limpeza por idade |
| `claudeCodeLauncher.historyMaxStorageMB` | `128` | Orçamento local em MiB; atingir o limite suspende novas capturas |

Pendências, decisões parciais e referências necessárias à recuperação não são descartadas para caber no orçamento. Uma leitura parcial ou um registro inválido não permite declarar que todo o histórico foi processado. O diagnóstico de entradas inválidas evita copiar novamente seu conteúdo para relatórios.

**Limpar histórico revisado** remove entradas elegíveis do histórico, preservando revisões e recuperação. Por isso, não equivale a liberar todo o armazenamento.

**Apagar todos os dados locais de revisão** pede confirmação, pausa a captura e exige que os produtores cooperantes estejam parados. Remove os dados próprios de revisão e recuperação; mantém os arquivos atuais do projeto e configurações de terceiros. A captura permanece pausada até você ativá-la novamente. Falhas e conflitos são informados como limpeza parcial ou bloqueada. Esse comando não apaga os transcripts originais do Claude, backups externos nem cópias no Git.

### Arquivos e recuperação

O diretório `.claude/launcher-changes/` é local e recebe regra de exclusão do Git. Não force sua inclusão: ele pode conter código e metadados privados.

| Caminho | Responsabilidade |
| --- | --- |
| `log.jsonl`, `blobs/` | Eventos capturados e versões de conteúdo |
| `review-state.v1.json`, `.prev`, `review-blobs/v1/` | Estado canônico, geração anterior, decisões e recuperação |
| `status.json` | Projeção de decisões completas para compatibilidade; estado misto não vira decisão homogênea |
| `review-writer.lock` | Propriedade cooperante da escrita de revisão |
| `review-migration-backups/` | Backups da migração e recuperação |
| `meta.json` | Pedido e explicação associados aos eventos |
| `capture-policy.json`, `capture-status.json` | Política de captura, pausa e diagnóstico |
| `active/`, `pending/`, `completed/` | Coordenação e idempotência do hook |

Somente uma janela nova escreve a revisão de cada projeto por vez. As demais ficam em leitura. Use **Liberar revisão para outra janela** na proprietária e **Recuperar revisão bloqueada** na janela que assumirá. Um proprietário ativo ou ambíguo não é removido por idade do lock.

Após uma queda, o comando de recuperação verifica o proprietário. Se houver um `review-recovery.lock` órfão, o procedimento é offline: encerre todas as janelas e conversas que usam o projeto, faça uma cópia de `.claude/launcher-changes/`, confira o PID registrado e só remova **esse guard** quando comprovar que o processo terminou. Não remova um lock de uma janela ativa nem edite o estado canônico para forçar uma decisão. Um guard de manutenção de captura também exige quiescência e inspeção antes de qualquer intervenção.

A versão 0.7.0 não participa desse protocolo. Não mantenha versões antigas e novas escrevendo no mesmo projeto. Para downgrade, encerre os escritores e preserve o diretório de revisão: o formato antigo não representa decisões parciais, estado misto nem toda a recuperação nova. Reinstalar o executável anterior não desfaz o conteúdo dos arquivos.

## Comandos operacionais

Todos aparecem na categoria **Claude Code Launcher** da paleta, além das ações nas views:

| Comando | Uso |
| --- | --- |
| Abrir chat na barra lateral / Abrir chat em nova aba | Abrir a integração oficial |
| Nova conversa em aba | Solicitar nova conversa |
| Instalar Claude Code | Instalar a extensão oficial por ação explícita |
| Mostrar mudanças do Claude | Abrir o painel maior |
| Ativar / Desligar registro de mudanças | Gerir hooks próprios |
| Limpar histórico revisado | Limpar histórico elegível mantendo recuperação |
| Apagar todos os dados locais de revisão | Limpeza completa coordenada, com confirmação |
| Liberar revisão para outra janela | Encerrar a propriedade local da revisão |
| Recuperar revisão bloqueada | Assumir uma revisão liberada ou recuperar proprietário comprovadamente encerrado |
| Aceitar / Recusar todas as mudanças pendentes do Claude | Revisar o lote admitido |
| Desfazer a última recusa | Recuperar o último lote, mantendo itens que não puderem ser restaurados |
| Ligar/desligar marcas das mudanças no código | Alterar a apresentação inline |
| Próxima / Mudança anterior do Claude | Navegar pelos trechos |

## Desenvolvimento e validação

Use Node.js 22+ e o lockfile do projeto:

```sh
npm ci --ignore-scripts --no-audit --fund=false
npm run typecheck
npm test
npm run test:package
npm audit --audit-level=moderate
npm run package -- --out claude-code-launcher-0.8.0.vsix
npm run verify:package -- claude-code-launcher-0.8.0.vsix
```

`vscode:prepublish` chama o build. Ele remove a saída gerada antiga e compila com `noEmitOnError`. Os testes de pacote usam árvores temporárias, inclusive uma árvore sem `out/` e outra com saída obsoleta. O verificador inspeciona o VSIX real, compara bytes com o runtime atual, calcula SHA-256 e rejeita conteúdo inesperado. `docs/`, testes, scripts, configurações locais e dependências de desenvolvimento ficam fora do VSIX.

Os testes de `test/*.test.js` usam regras reais e adaptadores explícitos onde o editor não está presente. Para testar o Extension Host, compile e execute:

```sh
npm run test:host -- --editor code
npm run test:host -- --editor cursor
npm run test:host -- --editor code --vsix claude-code-launcher-0.8.0.vsix --keep
```

O runner cria workspace, perfil, diretório de extensões e configuração Claude temporários. O modo `--vsix` instala e exercita o pacote nesse perfil isolado. Não altera o perfil normal nem envia mensagens ao Claude. `--keep` mantém as evidências; falhas também preservam o diretório. O cenário é um workspace sintético confiável, não um teste do Restricted Mode.

No macOS, os caminhos padrão são os aplicativos em `/Applications`. Para outra instalação, use `--executable /caminho/do/editor`; no modo `--vsix`, informe também `--cli /caminho/Resources/app/out/cli.js` **da mesma instalação**. Em outros sistemas, esses caminhos precisam ser informados. A matriz CI prepara checks em Linux, Windows e macOS; sua configuração não comprova uma execução remota aprovada.

Para medir a listagem de conversas com arquivos sintéticos, rode `node scripts/benchmark-sessions.cjs docs/validacao/sessoes.json`. Um segundo argumento aceita um módulo de baseline conhecido para comparação pareada. O relatório registra cinco amostras com 15, 1.000 e 5.000 arquivos, tempos de conclusão, uma sonda de disponibilidade do event loop e hashes dos módulos. O cache do sistema operacional não é limpo. A listagem usa até oito operações de stat simultâneas, 10.000 candidatos e 256 leituras de título por chamada; esses limites não constituem uma promessa de latência.

Os PRDs, specs e registros de implementação em `docs/` são locais e estão ignorados pelo Git. Não use `git add -f docs/`. Gerar um VSIX não executa commit, push nem publicação em Marketplace/Open VSX.
