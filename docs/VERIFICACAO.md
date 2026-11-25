# Verificação e compatibilidade

Detalhes de verificação do Launcher for Claude Code, separados do README para mantê-lo objetivo. O comportamento completo está na [referência](REFERENCIA.md). [English version](VERIFICATION.md).

## Escopo da verificação

As jornadas de teste cobrem ativação, comandos, preservação das preferências com a gestão desligada, CRLF, UTF-8 com BOM, recusa de criação, desfazer, revisão parcial e edição humana entre capturas. BOM, Unicode e final de linha são conferidos no documento e nos bytes salvos. Alteração da presença do BOM, finais de linha mistos e UTF-8 inválido devem bloquear a reversão.

No modo VSIX, uma jornada adicional executa o hook instalado em um arquivo sintético e verifica sua ingestão e revisão no editor. Os testes de adaptadores abrangem falhas de gravação, recuperação e concorrência. Notebooks com alterações não salvas e providers virtuais recebem testes negativos reais, que comprovam a preservação dos buffers e o bloqueio de mutações; isso não habilita a revisão desses recursos, e a revisão de recursos não admitidos bloqueia alterações de conteúdo.

Esses cenários não comprovam a abertura autenticada de conversas nem o funcionamento em hosts remotos. Os relatórios identificam o editor, o sistema e o artefato de cada execução. Uma matriz configurada não equivale a um resultado aprovado.

A validação comum fixa o VS Code 1.94.0, a versão mínima declarada. Toda semana, o workflow de compatibilidade (`.github/workflows/compat.yml`) repete a instalação do VSIX, a jornada do hook e o contrato `official` no VS Code estável mais recente e na versão atual da extensão oficial, para avisar cedo quando um comando interno do Claude Code (`claude-vscode.*`) ou o formato dos hooks mudar. Uma execução aprovada vale para as versões daquela data; o resumo do job registra quais foram.

Os testes de Node também carregam as páginas das views em português e com o dicionário em inglês, e `test/l10n.test.js` reprova quando uma frase marcada no código não tem tradução ou quando o manifesto usa uma chave ausente em `package.nls.json` ou `package.nls.pt-br.json`.

## Ambientes remotos

O launcher e a extensão oficial são extensões de workspace: numa janela remota, os dois rodam no host do workspace, e o hook usa o `node` e o `~/.claude` desse host. Isso decorre do manifesto (`extensionKind: ["workspace"]` no launcher; a oficial não declara `extensionKind` e, por rodar código, fica no workspace) e não foi exercitado numa janela remota real: WSL, Remote-SSH, Dev Containers e Codespaces **não têm teste automatizado**.

O que foi verificado em 22/11/2026, na 1.2.9:

- a suíte de testes Node inteira (407 testes, inclusive o hook por edição, a captura do turno executada como processo e o controlador com o editor simulado) passou num contêiner `node:22-bookworm-slim` (Debian 12, Node 22.23.5), com usuário sem privilégios, `HOME` temporário e sem lixeira no sistema;
- os testes cobrem, com o editor simulado, as duas diferenças de uma janela remota: revelar no Explorer ou copiar o caminho em vez de abrir o gerenciador de arquivos local, e a recusa de um arquivo criado que para com o motivo quando a lixeira não existe, sem apagar em definitivo.

Para conferir num ambiente remoto real, siga a lista em [REFERENCIA.md](REFERENCIA.md#janelas-remotas-wsl-e-contêineres).

## Captura por comando

`test/hook-turn.test.js` exercita o hook do turno com arquivos reais: criação, mudança e exclusão por comando com antes e depois revisáveis, um segundo `Stop` no mesmo turno, edições do Edit/Write que não se repetem e um formatador depois delas, as exclusões (`.git`, `node_modules`, `.gitignore` da raiz e de subpastas com negações, privacidade, binários), as regras do `.gitignore` (âncoras, só pastas, negação, classes, `**` e escapes), captura pausada, manutenção, manifesto adulterado, orçamento das cópias, coleta das cópias antigas e a saída vazia do processo. `test/turn-capture.test.js` liga o resultado ao painel: o rótulo, o pedido e a explicação tirados do transcript e o aviso de terminal dispensado. O contrato `official` com o Claude Code real continua cobrindo só o formato dos hooks no evento Setup; uma conversa real com `UserPromptSubmit` e `Stop` não é automatizada.

## Compatibilidade de hooks

A compatibilidade de hooks é verificada separadamente. O modo automático exige que o schema da extensão oficial selecionada declare `command` com `args` separados. Não se presume uma versão mínima do Claude a partir dessa capacidade. Consulte o [contrato oficial dos hooks](https://code.claude.com/docs/en/hooks#command-hook-fields).


## Registro da 1.0.0

Execuções locais com o VSIX 1.0.0 (SHA-256 `2801856e2ab1cec8565d8ebe7beb7d788a1b2dba2cbf7b70961be4cd8ae4bbc8`), em 2026-11-20, Linux x64, Node do runner 23.6.0:

| Cenário | Editor | Resultado |
| --- | --- | --- |
| `test:host` (14 jornadas, inclusive hook instalado → Node externo → recusa) | VS Code 1.147.0, Node do host 24.22.1 | aprovado |
| `test:host` (14 jornadas) | Cursor 3.30.14, API 1.128.0, Node do host 24.22.1 | aprovado |
| `test:host:contracts multi-window` | VS Code 1.147.0 | aprovado |
| `test:host:contracts lifecycle` | VS Code 1.147.0 | aprovado |
| `test:host:contracts official`, extensão oficial Claude Code 2.1.329 (linux-x64) | VS Code 1.147.0 | aprovado |

O SHA-256 se refere ao pacote testado nessa data, ainda com o nome `claude-code-launcher`. Depois dele, a extensão passou a se chamar `launcher-for-claude-code` (o nome anterior pertence a outro publisher no Marketplace), e o CHANGELOG e o manifesto mudaram. O código de runtime empacotado é o mesmo, mas o pacote distribuído tem outro hash; a evidência que vale para a distribuição é a da CI no commit publicado. Os limites da seção [Escopo da verificação](#escopo-da-verificação) continuam valendo: nenhum desses cenários comprova uma conversa autenticada.
