# Tucano Proxy extension for Pi

No Tucano, abra Configurações → MCP e clique em Instalar na linha Pi. A extensão e sua configuração são instaladas em `~/.pi/agent/extensions/tucano/`. Reinicie o Pi ou execute `/reload`.

A opção “Abrir o Tucano quando necessário” é aplicada automaticamente à extensão instalada. As chamadas usam a ponte nativa do Tucano, que pode iniciar o app quando necessário. Remover pelo Tucano apaga apenas os três arquivos da integração; outras extensões são preservadas.

## Instalação manual (alternativa)

Instalação manual: copie `tucano.ts` e `tucano-tools.json` para `~/.pi/agent/extensions/` (Pi carrega extensões `.ts` desse diretório automaticamente).
Crie `~/.pi/agent/tucano.json` com `{ "url": "http://127.0.0.1:7878/mcp", "token": "<token do arquivo mcp-settings.json do Tucano>" }` — ou defina `TUCANO_MCP_URL` / `TUCANO_MCP_TOKEN` no ambiente, que têm prioridade sobre o arquivo.
Abra o Pi normalmente (`pi`); as tools `tucano_*` aparecem na lista de tools mesmo com o Tucano fechado (usa o snapshot `tucano-tools.json` nesse caso).
Com o Tucano aberto e o token correto, cada tool chama `tools/call` no endpoint MCP real e devolve o texto do resultado; com o app fechado ou token errado, a tool devolve uma mensagem de erro amigável em vez de travar o Pi.
Rode `/reload` no Pi após atualizar estes arquivos para recarregar a extensão sem reiniciar a sessão.
