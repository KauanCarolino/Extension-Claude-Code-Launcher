# Claude Code Launcher

Extensão para o Cursor e o VS Code que abre o chat oficial do Claude Code e mostra, no editor, o que ele mudou em cada arquivo.

O chat é o da extensão oficial **Claude Code** (`anthropic.claude-code`), com as ferramentas e as permissões dela. Esta extensão não coloca um botão dentro do painel do Agent do Cursor e não substitui esse painel.

Versão atual do pacote: `claude-code-launcher-0.6.0.vsix`.

## Requisitos

- Cursor ou VS Code 1.85 ou mais novo.
- A extensão oficial Claude Code. Se ela não estiver instalada, o launcher oferece para instalar.
- Node.js no PATH, só para o registro de mudanças.

## Instalar

1. Em Extensions, abra o menu `...` e escolha **Install from VSIX**.
2. Selecione `claude-code-launcher-0.6.0.vsix`.
3. Na primeira abertura do chat, aceite instalar o Claude Code oficial, se ele ainda não estiver presente.

Para desenvolver a partir deste repositório, abra a pasta no Cursor e use **Run Extension** (F5). O código TypeScript em `src/` é compilado para `out/`.

`npm test` compila e roda os testes de `test/` com o runner do próprio Node (Node 20 ou mais novo). Eles cobrem o diff, as regras de revisão (`src/logic.ts`) e a leitura dos transcripts; nenhum precisa do editor aberto.

## Abrir o chat

O chat oficial pode ser aberto por estes atalhos:

| Onde | O que faz |
| --- | --- |
| Barra de título do editor, ícone de balão | Abre o chat na barra lateral |
| Barra de status, à direita, **Claude** | Abre o chat na barra lateral |
| Barra de atividades, ícone Claude Code, view **Claude Code** | Lista conversas e abre uma nova em aba |
| Paleta de comandos | Comandos da categoria **Claude Code Launcher** |

**Abrir chat na barra lateral** pede a barra lateral do Claude Code. Esse caminho não abre o chat como aba de editor. Se a barra lateral secundária estiver desligada, o editor avisa para ativá-la em View > Appearance > Secondary Side Bar.

**Nova conversa em aba** abre uma conversa nova como aba do editor. O grupo dessa aba fica travado: uma aba de arquivo que entrar nele é movida para outro grupo. O mesmo vale ao reabrir uma conversa recente.

O botão de nova conversa do próprio Claude Code segue a preferência `claudeCode.preferredLocation`. Com o valor `sidebar`, o Cursor coloca essa conversa na view do Claude dentro do Explorer. O launcher mantém essa preferência em `panel`, no usuário e na pasta, para a conversa nova abrir numa aba. Se a extensão oficial gravar `sidebar` de novo, o valor volta para `panel`. O botão de barra lateral deste launcher não depende dessa preferência: ele chama a barra lateral direto.

## View Claude Code

A view **Claude Code**, na barra de atividades, mostra:

- **+ Nova conversa em aba**
- **Abas abertas**: clique numa linha para ir até a aba; **×** fecha essa aba
- **Conversas recentes**: as 15 conversas mais recentes do projeto aberto. Clique para retomar a conversa numa aba. Uma conversa já aberta leva até a aba existente.

Os títulos vêm dos transcripts do Claude Code em `~/.claude/projects/` (ou em `CLAUDE_CONFIG_DIR`, se essa variável existir). A lista usa o título escolhido por você, senão o título gerado pelo Claude, senão a primeira mensagem. Sem uma pasta aberta, as conversas recentes não aparecem.

## View Mudanças

A view **Mudanças** guarda cada arquivo que o Claude criar ou editar com as ferramentas Edit, Write, MultiEdit e NotebookEdit.

No topo, um bloco **N arquivos para revisar** lista os arquivos com mudanças do Claude que você ainda não aceitou nem recusou, no mesmo espírito da lista de arquivos do Cursor. Cada linha mostra o nome, `+` linhas novas ou modificadas, `−` linhas removidas, e a marca **novo** quando o arquivo foi criado. O número junta a primeira edição pendente com a última. Clique na linha para ver a mudança no código; se o arquivo foi apagado, o clique tenta abri-lo. **Revisar**, nesse bloco, abre o painel em tela maior.

Aceitar e recusar:

- **✓** e **✕**, que aparecem ao passar o mouse numa linha, aceitam ou recusam aquele arquivo.
- **✓ Aceitar todos** mantém tudo como o Claude deixou e esvazia o bloco. O histórico continua, com a marca **aceita**.
- **✕ Recusar todos** pede confirmação e volta cada arquivo para como era antes do Claude: o texto anterior é restaurado, arquivos criados por ele vão para a lixeira e arquivos apagados por ele são recriados. O histórico ganha a marca **recusada**.
- Recusar nunca mexe num arquivo que mudou depois da última edição do Claude, nem num arquivo sem cópia do conteúdo anterior (mais de 512 KB). Esses ficam no bloco e um aviso lista quais foram. Dá para recusá-los trecho a trecho em **Ver no código**.
- Depois de recusar, o aviso tem **Desfazer**, e a barra do painel mostra **↶ Desfazer recusa** até a próxima recusa. Desfazer só devolve arquivos que continuam como a recusa deixou.

Quando nada está pendente, o bloco some e o painel diz que tudo foi revisado.

Abaixo fica o histórico. As edições feitas para atender a mesma mensagem sua ficam agrupadas sob **Pedido**, com o texto da mensagem e quantos arquivos ela mudou. **Desfazer pedido** volta esses arquivos para como eram antes do pedido, com as mesmas proteções de **Recusar todos**. O pedido vem do transcript da conversa; edições sem transcript aparecem soltas.

Cada card de edição mostra:

- a ação (criou, reescreveu, editou, editou notebook);
- um resumo em texto, com contagem de linhas novas, removidas e modificadas;
- o que o Claude disse logo antes de editar;
- os trechos, com linhas novas em verde e removidas em vermelho. Numa linha modificada, as versões de antes e de depois aparecem juntas, e as palavras que mudaram ficam em destaque.

Ações do card e da barra:

- **Ver no código** abre o arquivo e mostra as marcas da revisão no editor.
- **Lado a lado** abre o diff nativo, antes e depois daquela edição.
- **Abrir arquivo** aparece quando não há um antes e um depois para comparar.
- **Tela maior** abre o mesmo painel numa aba do editor. O ícone de diff no título da view faz o mesmo.
- **Atualizar** relê o histórico.
- **Limpar** apaga o histórico deste projeto e mantém o registro ligado.
- **Ativar** e **Desligar** ligam e desligam o registro.

O registro só vale para conversas iniciadas depois de ativar. Um arquivo com mais de 512 KB não tem o texto guardado; o card avisa isso. O histórico mostra as 60 edições mais recentes. O log guarda até 400 edições: acima disso, as revisadas mais antigas saem, e as pendentes ficam sempre.

### Fora do painel

- **Explorer**: arquivos com mudanças pendentes ganham a letra **C** e uma cor própria (`claudeCodeLauncher.pendingChangeForeground`, ajustável no tema).
- **Barra de status**: `✦ N` mostra quantos arquivos faltam revisar; o clique abre o painel. Some quando não há nada pendente.
- **Navegação**: `Alt+]` vai para o próximo trecho do Claude e `Alt+[` para o anterior. No fim do arquivo, passa para o próximo arquivo pendente. Os atalhos só valem quando há mudanças pendentes e nenhuma sugestão inline aberta; dá para trocá-los em Keyboard Shortcuts.

### Como o registro funciona

**Ativar** grava um hook `PreToolUse` e `PostToolUse` em `.claude/settings.local.json` do projeto. O hook chama `node` e não altera o que o Claude faz: se falhar, a edição segue. **Desligar** remove só esses hooks e deixa o resto do arquivo como está. Se o JSON estiver inválido, o arquivo não é modificado.

O histórico fica em `.claude/launcher-changes/log.jsonl`. A pasta tem um `.gitignore` com `*`, para nada dela entrar no git. O script do hook é copiado para essa mesma pasta (`launcher-record-change.js`), então o registro continua funcionando se o projeto for aberto em outro editor (Cursor ou VS Code). Ao abrir o projeto, a extensão atualiza essa cópia e corrige o caminho no `settings.local.json` se ele apontar para outro lugar, como nas versões anteriores, que usavam o armazenamento global do editor.

Aceitar e recusar ficam guardados no estado do projeto no editor, não no log.

## Marcas no código

Com **Claude Code Launcher: Marca no próprio editor as linhas que o Claude adicionou, modificou ou removeu** ligado (padrão), o arquivo aberto mostra a revisão enquanto o texto continuar como o Claude deixou:

- linha nova ou modificada com fundo verde e uma faixa na margem;
- palavras alteradas em destaque;
- linha removida indicada por uma borda tracejada e, no hover, o texto que saiu.

Acima do primeiro trecho, as lentes de código oferecem:

- o motivo curto que o Claude deu, que abre a view Mudanças;
- **Lado a lado**, comparando o arquivo de antes de todas as edições ainda em revisão com o arquivo atual;
- **Aceitar** e **Recusar** em cada trecho;
- **Aceitar tudo** e **Recusar tudo** no arquivo.

Aceitar um trecho confirma aquela parte e tira a marca. Recusar um trecho devolve o texto antigo para o arquivo. Quando não resta diferença, a revisão daquele arquivo acaba. Se você editar o arquivo por conta própria, as marcas acompanham a diferença entre o texto de antes do Claude e o texto atual.

A configuração fica em Settings, em **Claude Code Launcher**, chave `claudeCodeLauncher.inlineChanges`. O comando **Ligar/desligar marcas das mudanças no código** inverte essa opção.

## Comandos

Na paleta de comandos, categoria **Claude Code Launcher**:

| Comando | Função |
| --- | --- |
| Abrir chat na barra lateral | Abre o chat oficial na barra lateral |
| Abrir chat em nova aba | Abre uma conversa nova como aba |
| Nova conversa em aba | O mesmo que abrir em nova aba |
| Instalar Claude Code | Instala a extensão oficial |
| Mostrar mudanças do Claude | Abre o painel de mudanças numa aba |
| Ativar registro de mudanças | Instala o hook no projeto |
| Desligar registro de mudanças | Remove o hook do projeto |
| Limpar histórico de mudanças | Apaga o `log.jsonl` |
| Ligar/desligar marcas das mudanças no código | Liga ou desliga as marcas no editor |
| Aceitar todas as mudanças pendentes do Claude | Aceita todos os arquivos do bloco **para revisar** |
| Recusar todas as mudanças pendentes do Claude | Recusa todos os arquivos do bloco, com confirmação |
| Desfazer a última recusa | Traz de volta o que a última recusa desfez |
| Próxima mudança do Claude (`Alt+]`) | Vai para o próximo trecho, passando de arquivo no fim |
| Mudança anterior do Claude (`Alt+[`) | Vai para o trecho anterior |
| Aceitar todas as mudanças do Claude neste arquivo | Confirma a revisão do arquivo |
| Recusar todas as mudanças do Claude neste arquivo | Desfaz a revisão do arquivo |
| Ocultar marcas (aceita as mudanças do Claude neste arquivo) | O mesmo que aceitar tudo |

**Aceitar trecho**, **Recusar trecho**, **Ver mudança no código** e **Comparar lado a lado** existem para as lentes e para a view. Eles não aparecem na paleta.

## O que fica de fora

- O compositor do Agent do Cursor, com o seletor de modelo e o modo Agent, não é reutilizado.
- A barra lateral do chat não recebe abas de arquivo. Uma conversa aberta em aba também não fica no mesmo grupo que arquivos.
- O registro não lê edições feitas antes de ser ativado, nem ferramentas que não sejam Edit, Write, MultiEdit ou NotebookEdit.
