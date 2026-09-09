# Tucano Proxy extension for Pi

No Tucano, abra Configurações → MCP e clique em Instalar na linha Pi. A extensão e sua configuração são instaladas em `~/.pi/agent/extensions/tucano/`. Reinicie o Pi ou execute `/reload`.

A opção “Abrir o Tucano quando necessário” é aplicada automaticamente à extensão instalada. As chamadas usam a ponte nativa do Tucano, que pode iniciar o app quando necessário. Remover pelo Tucano apaga apenas os três arquivos da integração; outras extensões são preservadas.

## Instalação manual (alternativa)

Instalação manual: copie `tucano.ts` e `tucano-tools.json` para `~/.pi/agent/extensions/` (Pi carrega extensões `.ts` desse diretório automaticamente).
Crie `~/.pi/agent/tucano.json` com `{ "url": "http://127.0.0.1:7878/mcp", "token": "<token do arquivo mcp-settings.json do Tucano>" }` — ou defina `TUCANO_MCP_URL` / `TUCANO_MCP_TOKEN` no ambiente, que têm prioridade sobre o arquivo.
Abra o Pi normalmente (`pi`); as tools `tucano_*` aparecem na lista de tools mesmo com o Tucano fechado (usa o snapshot `tucano-tools.json` nesse caso).
Com o Tucano aberto e o token correto, cada tool chama `tools/call` no endpoint MCP real e devolve o texto do resultado; com o app fechado ou token errado, a tool devolve uma mensagem de erro amigável em vez de travar o Pi.
Rode `/reload` no Pi após atualizar estes arquivos para recarregar a extensão sem reiniciar a sessão.

## Serviço CLI independente

A skill oficial é uma alternativa à extensão MCP: `tucano-proxy skill install --agent pi` ensina o agente a usar diretamente os comandos do CLI.

Para usar a extensão com um serviço CLI configurado para MCP, a configuração também aceita `binary` (caminho do executável), `autolaunch`, `dataDir` (raiz dos dados do CLI) e `session` (nome da sessão). A ponte `mcp-stdio` usa esse contexto para iniciar a sessão correta sem abrir o desktop. `TUCANO_MCP_DATA_DIR` e `TUCANO_MCP_SESSION` têm precedência sobre o arquivo, assim como as variáveis de URL/token. Mantenha tokens fora do repositório.
