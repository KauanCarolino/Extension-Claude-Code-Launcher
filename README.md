# Claude Code Launcher

Extensão para Cursor e Visual Studio Code que abre o chat oficial do Claude Code e permite revisar as mudanças dele no painel e no editor.

O chat, a autenticação, os modelos e as permissões pertencem à extensão oficial **Claude Code** (`anthropic.claude-code`). O launcher usa essa integração; não incorpora o Agent do Cursor.

Versão: **0.10.0**. Pacote local: `claude-code-launcher-0.10.0.vsix`.

## Requisitos e compatibilidade

- Visual Studio Code **1.94.0 ou superior**. No Cursor, a API do editor precisa ser compatível; os alvos de verificação estão na tabela abaixo.
- Extensão oficial Claude Code para abrir conversas. A instalação só ocorre quando você escolhe **Instalar**.
- Workspace confiável e arquivos locais para a revisão e a captura. O launcher fica desabilitado no Restricted Mode.
- Node.js **22 ou superior** no `PATH` para o fluxo de desenvolvimento e para executar o hook local. O Node embutido no Extension Host é independente do Node do terminal.

| Editor | Alvos do teste de host |
| --- | --- |
| VS Code 1.94.0, Node do host 20.16.0 | macOS arm64 local; Linux, Windows e macOS na CI |
| VS Code 1.146.0, Node do host 24.22.1 | macOS arm64 |
| Cursor 3.19.13, API VS Code 1.128.0, Node do host 24.18.1 | macOS arm64 |

As jornadas cobrem ativação, comandos, preservação das preferências com gestão desligada, CRLF, UTF-8 com BOM, recusa de criação, desfazer, revisão parcial e edição humana entre capturas. BOM, Unicode e final de linha são conferidos no documento e nos bytes salvos; alteração da presença do BOM, finais de linha mistos e UTF-8 inválido devem bloquear a reversão. No modo VSIX, uma jornada adicional executa o hook instalado em um arquivo sintético e verifica sua ingestão e revisão no editor. Os testes de adaptadores cobrem falhas de gravação, recuperação e concorrência. Abertura autenticada de conversas e hosts remotos não são comprovados por esses cenários. Notebooks sujos e providers virtuais recebem testes negativos reais, que comprovam preservação dos buffers e bloqueio de mutações; isso não habilita revisão desses recursos. A revisão de recursos não admitidos bloqueia alterações de conteúdo. Os relatórios identificam o editor, o sistema e o artefato de cada execução; uma matriz configurada não equivale a um resultado aprovado.

A compatibilidade de hooks é verificada separadamente: o modo automático exige que o schema da extensão oficial selecionada declare `command` com `args` separados. Não se presume uma versão mínima do Claude a partir dessa capacidade. Consulte o [contrato oficial dos hooks](https://code.claude.com/docs/en/hooks#command-hook-fields).

## Instalação

1. Em **Extensions**, abra o menu `…` e escolha **Install from VSIX**.
2. Selecione `claude-code-launcher-0.10.0.vsix`.
3. Abra a pasta do projeto e use um comando da categoria **Claude Code Launcher**.
4. Para registrar novas mudanças, use **Ativar registro de mudanças** e inicie uma nova conversa do Claude.

Atualizar o pacote não publica a extensão nem envia o histórico para um serviço externo. Os dados locais podem conter código e trechos de conversas; consulte a política de armazenamento abaixo.

## Abrir e organizar conversas

O ícone de balão no título do editor e o item **Claude** na barra de status abrem a barra lateral oficial. **Nova conversa em aba** e **Abrir chat em nova aba** usam o editor de conversas do Claude. A view **Claude Code** mostra:

- **Nova conversa**, que abre uma conversa nova em aba;
- uma lista só de conversas, uma linha cada, com o tempo à direita:
  - **Abertas**: as conversas abertas em aba, com um ponto cheio na aba ativa e vazado nas outras. Clique para ir até a aba; **×**, ao passar o mouse, fecha essa aba.
  - **Hoje**, **Ontem**, **Esta semana**, **Este mês** e **Mais antigas**: até 15 conversas recentes das pastas locais do workspace, sem repetir as que já estão abertas. Clique para retomar a conversa numa aba.
- **Buscar conversas**, quando a lista passa de 6 conversas. A busca ignora acentos e maiúsculas; `Esc` limpa.

O título da view tem **Nova conversa** e **Atualizar conversas**. A lista funciona pelo teclado: `Tab` entra nela e as setas para cima e para baixo andam entre as linhas.

Os títulos vêm de `~/.claude/projects/`, ou de `CLAUDE_CONFIG_DIR` quando definido. A leitura é assíncrona, usa cache limitado e mostra um aviso quando a lista está parcial. Resultados de uma view já fechada são descartados.

O launcher informa quando a extensão oficial está ausente, a ativação demora, o comando não está disponível ou a abertura da aba não é confirmada. Um erro de autenticação informado pelo Claude orienta a fazer login. O launcher não possui uma API pública para consultar o estado de login; uma aba já aberta não comprova que uma nova conversa abriu. Quando necessário, o endereço de abertura usa o protocolo do editor atual, inclusive `cursor://`.

A organização automática dos grupos vem **desligada**. Ative `claudeCodeLauncher.manageEditorGroups` se quiser separar arquivos do grupo do chat e gerir as preferências de abertura. Ao desligar, somente valores ainda pertencentes à extensão são restaurados. Uma alteração manual posterior encerra a gestão daquele valor até desligar e ligar a opção novamente. Outro workspace com a opção desligada não restaura as preferências geridas pelo workspace atual.

## Revisar mudanças

A view **Mudanças** reúne edições capturadas pelas ferramentas Edit, Write, MultiEdit e NotebookEdit. Capturar um evento de notebook não significa que a reversão dele esteja habilitada.

O bloco **Para revisar** lista os arquivos pendentes, com `+`/`−` e a marca **novo** ou **apagado**. **✓** e **✕**, no fim de cada linha, aceitam ou recusam o arquivo; clique na linha para abrir a revisão no código. O painel mostra decisões parciais, fase da revisão e bloqueios por arquivo. Um arquivo bloqueado fica com as ações desativadas, com motivo e orientação para retomar a revisão.

Na barra lateral, o histórico é uma lista compacta, sem diff, agrupada por dia e pelo pedido que originou as edições. Cada linha mostra o status (ponto laranja para revisar, ✓ aceita, ↶ recusada, ✓ em laranja para revisão **mista**), o arquivo, `+`/`−` e quando. Clique para ver a mudança no código; o ícone de diff, ao passar o mouse, abre o antes e depois daquela edição. O tooltip traz o resumo e o que o Claude disse. **Desfazer pedido** aparece ao passar o mouse no pedido. **Ver os diffs na tela maior**, no fim da lista, abre o painel completo.

O estado aparece ao lado do título da view (**Registro configurado**, **Registro desligado** ou **Somente leitura**), e o número de arquivos para revisar aparece no ícone do Claude Code na barra de atividades. **Registro configurado** indica a presença dos handlers; a observação e a conclusão de capturas aparecem separadamente no diagnóstico. As ações ficam no título da view:

- **Recuperar revisão bloqueada**, quando esta janela está só para leitura, e **Desfazer recusa**, quando há recusa para desfazer;
- **Atualizar** e **Tela maior**;
- no menu `...`: aceitar ou recusar todas as pendentes, ligar/desligar as marcas no código, ativar ou desligar o registro, **Limpar histórico revisado**, **Apagar todos os dados locais de revisão** e **Liberar revisão para outra janela**.

A **tela maior** abre o mesmo painel numa aba, com essas ações na barra do topo. Cada edição é um card com o resumo, o pedido e a explicação encontrados no transcript e os trechos de diff, com um alternador **Unificado / Lado a lado**. Trechos com mais de 60 linhas começam recolhidos. Os cards abertos, o bloco recolhido e a legenda continuam como você deixou ao reabrir o painel, e a rolagem não pula quando chega uma mudança nova. Quando a revisão está só para leitura, os botões que alteram a revisão ficam desativados e um aviso explica o motivo.

- **Aceitar** mantém o conteúdo e registra a decisão. Aceitar um trecho incorpora somente aquele trecho à base da revisão.
- **Recusar** restaura somente a parte ainda pendente. Uma parte aceita no editor continua aceita ao usar o painel ou recarregar a janela.
- Uma revisão com partes aceitas e recusadas recebe estado **misto**. Edições contínuas abrangidas pela decisão têm todos os seus IDs representados.
- Edições humanas, mudanças externas, identidade ambígua e snapshots insuficientes estabelecem barreiras. A ação pode ficar bloqueada ou atingir apenas o segmento contínuo comprovado; o launcher não volta através de uma edição humana para completar o lote.
- Recusar um arquivo criado restaura sua **ausência**. Arquivo vazio e arquivo inexistente são situações diferentes. Exclusões usam a lixeira; uma falha não provoca tentativa de exclusão permanente.
- A decisão que altera conteúdo só é concluída depois de aplicar, salvar e verificar o resultado. Uma falha de salvamento não aparece como recusa concluída. O resultado distingue alteração do conteúdo, salvamento e persistência da decisão; cancelamentos, conflitos e recuperação pendente trazem orientação específica por arquivo.
- **Desfazer a última recusa** usa recuperação persistida por item. Itens conflitantes continuam recuperáveis e não são consumidos como se tivessem sido restaurados. Uma intenção interrompida pode exigir reconciliação antes de uma nova ação.

As lentes oferecem **Aceitar** e **Recusar** por trecho. Quando há vários trechos, também oferecem aceitar ou recusar tudo. O comando **Ocultar marcas** aceita as mudanças pendentes daquele arquivo; para ocultar somente a apresentação, desligue `claudeCodeLauncher.inlineChanges`.

**Lado a lado** nas lentes compara a base da revisão atual, incluindo decisões parciais, com o arquivo observado. A comparação de um card mostra o antes/depois histórico daquela edição. Essas comparações respondem a perguntas diferentes.

Arquivos pendentes recebem a letra **C** no Explorer e uma contagem na barra de status. `Alt+]` e `Alt+[` percorrem os trechos. Cores podem ser ajustadas pelo tema, incluindo `claudeCodeLauncher.pendingChangeForeground`.

## Hooks e dados locais

Ativar o registro configura handlers próprios em `.claude/settings.local.json` e copia o script para `.claude/launcher-changes/`. O comando do hook usa executável e argumentos separados. Grupos mistos mantêm os handlers de terceiros; JSON inválido ou uma alteração concorrente bloqueiam a atualização da configuração.

O modo `auto` exige capacidade comprovada no schema. `exec` é uma escolha explícita para um harness que você verificou suportar esse formato. `disabled` desliga os hooks geridos. Não existe fallback automático por shell. O hook observa a edição; uma falha de captura não autoriza nem impede a operação original do Claude.

Ao atualizar a extensão, o script dos hooks já configurados é reparado automaticamente quando a capacidade, a política e a propriedade da escrita permitem. Uma captura pausada continua pausada. Bloqueios são informados; use **Ativar registro de mudanças** quando quiser reativar o registro e inicie uma nova conversa para o Claude carregar a configuração.

### Diagnóstico de captura

A view **Mudanças** mostra o diagnóstico por pasta do workspace, distinguindo quatro informações:

| Informação | O que ela comprova |
| --- | --- |
| Configuração | Os handlers próprios foram encontrados na configuração local |
| Capacidade de execução | O schema admite executável e argumentos separados, há escolha explícita de `exec` ou a capacidade permanece desconhecida |
| Observação | O hook deixou um registro datado de uma tentativa e de sua etapa |
| Conclusão conhecida | Há evidência de um evento gravado no histórico; a disponibilidade de conteúdo é indicada separadamente |

Configurar o hook não comprova que o Claude o executou. Um evento anterior à edição também não comprova sua conclusão. O painel apresenta orientação para situações como pausa, quota, permissão, espaço, preparação ou gravação indisponível. Se uma tentativa falhar depois de uma captura concluída, a evidência anterior continua datada; ela não representa atividade atual bem-sucedida.

Os diagnósticos usam registros imutáveis com etapas e motivos admitidos, sem código, prompts, transcripts, caminhos absolutos ou exceções brutas. A leitura é limitada. Dados legados, incompatíveis, ilegíveis ou uma leitura incompleta aparecem como diagnóstico desconhecido ou parcial, preservando as informações encontradas. Mesmo sem uma entrada nova no histórico, mudanças nos diagnósticos podem atualizar o painel.

**Cobertura não é universal:** os hooks abrangem Edit, Write, MultiEdit e NotebookEdit. Bash, PowerShell, MCP e alterações externas não são abrangidos por esse matcher. Conteúdo excluído, grande ou insuficiente não aparece como cópia integral. Ter snapshots disponíveis também não elimina as verificações de conflitos e recursos admitidos antes de uma reversão.

### Política de conteúdo

O histórico contém cópias locais em texto, sem criptografia própria. As exclusões padrão evitam novas cópias de `.env`, chaves privadas, certificados e alguns arquivos de credenciais. A política também impede novas cópias de pedidos e explicações para arquivos excluídos, inclusive em eventos antigos. Mudar uma exclusão não apaga cópias antigas nem garante que todo segredo possível seja reconhecido. Arquivos acima de **512 KiB** não têm o conteúdo integral capturado.

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

**Apagar todos os dados locais de revisão** pede confirmação, pausa a captura e exige que os produtores cooperantes estejam parados. Remove os dados próprios de revisão e recuperação; mantém os arquivos atuais do projeto e configurações de terceiros. A captura permanece pausada até você ativá-la novamente. Falhas e conflitos são informados como limpeza parcial ou bloqueada, com inventário do que permaneceu por categoria e orientação para a próxima tentativa. Um inventário incompleto não aparece como ausência de dados. Esse comando não apaga os transcripts originais do Claude, backups externos nem cópias no Git.

Uma limpeza interrompida mantém uma intenção mínima em `purge-state.v1.json`, sem conteúdo dos arquivos ou conversas. Enquanto ela existir, a versão 0.10 bloqueia revisão e reparo automático para impedir que os dados restantes sejam ingeridos novamente. Resolva a condição indicada e repita **Apagar todos os dados locais de revisão**; não remova esse marcador manualmente. Ele só é removido após a conclusão das etapas de disco e memória.

### Arquivos e recuperação

O diretório `.claude/launcher-changes/` é local e recebe regra de exclusão do Git. Não force sua inclusão: ele pode conter código e metadados privados.

| Caminho | Responsabilidade |
| --- | --- |
| `log.jsonl`, `blobs/` | Eventos capturados e versões de conteúdo |
| `review-state.v1.json`, `.prev`, `review-blobs/v1/` | Estado canônico, geração anterior, decisões e recuperação |
| `status.json` | Projeção de decisões completas para compatibilidade; estado misto não vira decisão homogênea |
| `review-writer.lock` | Propriedade cooperante da escrita de revisão |
| `review-migration-backups/` | Backups da migração e recuperação |
| `purge-state.v1.json` | Intenção de limpeza preparada ou parcial; bloqueia recriação automática até uma nova tentativa explícita concluir |
| `meta.json` | Pedido e explicação associados aos eventos |
| `capture-policy.json`, `capture-status.json` | Política de captura, pausa e diagnóstico legado; não comprovam sozinhos uma conclusão |
| `capture-diagnostics/v2/observations/`, `capture-diagnostics/v2/completions/` | Evidências separadas de tentativas e conclusões; retenção conservadora de 32 registros válidos por categoria, preservando dados desconhecidos |
| `active/`, `pending/`, `completed/` | Coordenação e idempotência do hook |

Somente uma janela nova escreve a revisão de cada projeto por vez. As demais ficam em leitura. Use **Liberar revisão para outra janela** na proprietária e **Recuperar revisão bloqueada** na janela que assumirá. Um proprietário ativo ou ambíguo não é removido por idade do lock.

Após uma queda, o comando de recuperação verifica o proprietário. Se houver um `review-recovery.lock` órfão, o procedimento é offline: encerre todas as janelas e conversas que usam o projeto, faça uma cópia de `.claude/launcher-changes/`, confira o PID registrado e só remova **esse guard** quando comprovar que o processo terminou. Não remova um lock de uma janela ativa nem edite o estado canônico para forçar uma decisão. Um guard de manutenção de captura também exige quiescência e inspeção antes de qualquer intervenção.

A versão 0.7.0 não participa desse protocolo. Não mantenha versões antigas e novas escrevendo no mesmo projeto. Para downgrade, encerre os escritores e preserve o diretório de revisão: o formato antigo não representa decisões parciais, estado misto nem toda a recuperação nova. Reinstalar o executável anterior não desfaz o conteúdo dos arquivos.

As versões 0.8 e 0.9 também não reconhecem a intenção de limpeza introduzida na 0.10. Conclua uma limpeza interrompida com a versão 0.10 antes de considerar um downgrade. Uso simultâneo dessas versões durante a limpeza não é suportado.

## Comandos operacionais

Todos aparecem na categoria **Claude Code Launcher** da paleta, além das ações nas views:

| Comando | Uso |
| --- | --- |
| Abrir chat na barra lateral / Abrir chat em nova aba | Abrir a integração oficial |
| Nova conversa em aba | Solicitar nova conversa |
| Instalar Claude Code | Instalar a extensão oficial por ação explícita |
| Mostrar mudanças do Claude | Abrir o painel maior |
| Atualizar mudanças | Reler o histórico e o estado da revisão |
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
npm run package -- --out claude-code-launcher-0.10.0.vsix
npm run verify:package -- claude-code-launcher-0.10.0.vsix
```

`vscode:prepublish` chama o build. Ele remove a saída gerada antiga e compila com `noEmitOnError`. Os testes de pacote usam árvores temporárias, inclusive uma árvore sem `out/` e outra com saída obsoleta. O verificador inspeciona o VSIX real, compara bytes com o runtime atual, calcula SHA-256 e rejeita conteúdo inesperado. `docs/`, testes, scripts, configurações locais e dependências de desenvolvimento ficam fora do VSIX.

Os testes de `test/*.test.js` usam regras reais e adaptadores explícitos onde o editor não está presente. Para testar o Extension Host, compile e execute:

```sh
npm run test:host -- --editor code
npm run test:host -- --editor cursor
npm run test:host -- --editor code --vsix claude-code-launcher-0.10.0.vsix --keep
npm run test:host -- --editor cursor --vsix claude-code-launcher-0.10.0.vsix --report-dir docs/validacao/host-cursor
```

O runner cria workspace, perfil, diretório de extensões e configuração Claude temporários. O modo `--vsix` instala e exercita o pacote nesse perfil isolado. Não altera o perfil normal nem envia mensagens ao Claude. `--keep` mantém o perfil temporário; falhas também preservam o diretório. `--report-dir` cria uma subpasta `run-*` exclusiva para cada execução, com os relatórios e logs correspondentes, preservando as execuções anteriores. O cenário é um workspace sintético confiável, não um teste do Restricted Mode.

A jornada de captura do pacote confere o hash do hook instalado contra sua entrada no VSIX, executa os eventos anterior e posterior com Node externo 22+, aguarda a ingestão pelas lentes públicas do editor e verifica uma recusa no documento, no disco e no estado persistido. Esse arquivo sintético não recebe eventos semeados diretamente no log. Os relatórios separam o Node externo do Node do Extension Host e vinculam o resultado ao hash do VSIX. Isso exercita o hook diretamente; não equivale a uma conversa autenticada nem à execução dos hooks pelo harness oficial do Claude.

No macOS, os caminhos padrão são os aplicativos em `/Applications`. Para outra instalação, use `--executable /caminho/do/editor`. O caminho do CLI é derivado dessa instalação; `--cli /caminho/Resources/app/out/cli.js` permite substituí-lo, mantendo **a mesma instalação**. Para baixar e exercitar uma versão exata do VS Code:

```sh
npm run test:host -- --download-version 1.94.0 --vsix claude-code-launcher-0.10.0.vsix --report-dir docs/validacao/host-minimum
```

`--download-version` aceita uma versão exata, somente para VS Code, e não pode ser combinado com `--executable` ou `--cli`. O download usa cache temporário fora do projeto. No Linux sem display, execute o comando com `xvfb-run -a`. A matriz CI inclui instalação do VSIX e a jornada do hook no VS Code 1.94.0 em Linux, Windows e macOS, além de tipagem, testes Node, testes de pacote e auditoria. Consulte os checks e as evidências da execução do commit que será distribuído.

Para medir a listagem de conversas com arquivos sintéticos, rode `node scripts/benchmark-sessions.cjs docs/validacao/sessoes.json`. Um segundo argumento aceita um módulo de baseline conhecido para comparação pareada. O relatório registra cinco amostras com 15, 1.000 e 5.000 arquivos por pasta, em duas pastas sintéticas, incluindo títulos ausentes e arquivos acima da janela de leitura. Cada combinação usa um processo novo com uma amostra fria e quatro aquecidas. Mede conclusão, disponibilidade do event loop, chamadas de IO, bytes lidos e variação de heap após GC explícito; registra os hashes dos módulos. Memória do processo e sonda de timer incluem ruído do runtime e não representam um SLA. O cache do sistema operacional não é limpo. A listagem usa até oito operações de stat simultâneas, 10.000 candidatos e 256 leituras de título por chamada; esses limites não constituem uma promessa de latência.

Os contratos adicionais também usam o VSIX instalado em perfis isolados:

```sh
npm run test:host:contracts -- multi-window --vsix claude-code-launcher-0.10.0.vsix --report-dir docs/validacao/janelas
npm run test:host:contracts -- lifecycle --vsix claude-code-launcher-0.10.0.vsix --report-dir docs/validacao/lifecycle
npm run test:host:contracts -- official --official-extension /caminho/da/extensao/anthropic.claude-code --vsix claude-code-launcher-0.10.0.vsix --report-dir docs/validacao/oficial
```

`multi-window` exercita duas janelas reais, recarregamento, decisão parcial e transferência explícita da escrita. `lifecycle` mede a ativação pública e instancia os componentes empacotados de revisão e lista de conversas com um contexto real e um observador que encaminha chamadas às APIs reais; repete painéis, troca de pastas e descarte durante refresh. O provider privado da lista é exposto somente no carregador de teste, sem mudar o código distribuído; a view real recebe mil sessões sintéticas. Seus contadores pertencem à instância observada e não representam todos os recursos do editor. `official` copia somente os arquivos de programa da extensão oficial já instalada para o diretório temporário, consulta o estado do CLI isolado e verifica uma aba oficial aberta sem enviar mensagem. Também usa o modo público [`--init-only`](https://code.claude.com/docs/en/hooks#setup) para testar o descritor de executável e argumentos em um evento Setup sintético, incluindo erro e timeout. Setup não equivale aos eventos de captura PreToolUse/PostToolUse; esses continuam identificados separadamente. Nenhum desses cenários comprova uma conversa autenticada ou a execução do hook pelo modelo. A matriz CI inclui os contratos de janelas e lifecycle; a extensão oficial depende de uma instalação local compatível com o sistema.

Os PRDs, specs e registros de implementação em `docs/` são locais e estão ignorados pelo Git. Não use `git add -f docs/`. Gerar um VSIX não executa commit, push nem publicação em Marketplace/Open VSX.
