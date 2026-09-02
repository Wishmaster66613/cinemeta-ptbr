# Agregador PT-BR (Stremio)

Addon para Stremio que **agrega os catálogos de vários outros addons** em um único catálogo por tipo (Filmes, Séries, etc.), traduz sinopses para PT-BR, prefere pôsteres em português (via TMDB) e aplica filtros opcionais e cumulativos.

## Como funciona

Um addon do Stremio não consegue ver quais addons você tem instalados no seu app — essa informação não existe na API do Stremio. Por isso este projeto mantém sua **própria lista de addons-fonte** (arquivo `addons.json`), busca o catálogo de cada um, mescla, remove duplicados (por `imdb_id`) e devolve tudo como um catálogo único chamado **"Agregado PT-BR"**.

### Filtros (todos opcionais e cumulativos)

1. **Tipo** — Filme, Série, ou qualquer outro tipo que alguma fonte ofereça (ex: canais de TV). É controlado pelo próprio Stremio (dropdown nativo "Filmes"/"Séries").
2. **Ano** — extra `year`.
3. **Novidades / Popularidade** — extra `sort`. "Novidades" ordena por ano decrescente; sem esse filtro (ou "Popularidade"), mantém a ordem intercalada entre as fontes.
4. **Gênero** — extra `genre`, com as opções somadas de todas as fontes.
5. **Busca** — extra `search`, repassado só às fontes que suportam busca.

> Atenção: nem todos os clientes Stremio exibem um dropdown para extras "customizados" como `sort` — `genre`, `search` e `skip` são os mais universalmente suportados pela interface. `year` e `sort` também aparecem na maioria das versões recentes, mas teste no seu cliente.

### Enriquecimento PT-BR

- Ao clicar em um item (`/meta`), se o id for do IMDb (`tt...`), busca sinopse e pôster PT-BR via TMDB (com fallback de tradução automática se o TMDB não tiver overview em pt-BR).
- Se o id não for do IMDb (ex.: addons de anime que usam Kitsu/AniList), o addon repassa a requisição de `/meta` para o addon de origem daquele item.
- Nos catálogos, os pôsteres exibidos na grade já são trocados por versões PT-BR quando disponíveis no TMDB.

## 1. Editar as fontes agregadas

Edite `addons.json` (array de `{ "name", "url", "enabled" }`) direto no GitHub, **ou** use o painel `/admin` depois de publicado:

```
https://SEU-SERVICO.onrender.com/admin
```

No `/admin` você pode adicionar, desativar ou excluir fontes. **Importante:** o Render (plano free) não tem disco persistente entre deploys — mudanças feitas no `/admin` valem enquanto o serviço está no ar, mas se cair/reiniciar ou você fizer um novo deploy, ele volta a usar o `addons.json` que está no GitHub. Use o botão **"Baixar addons.json"** no `/admin` e suba o arquivo atualizado no repositório para tornar a mudança permanente.

Opcional: defina a variável de ambiente `ADMIN_TOKEN` para proteger o `/admin` com uma senha simples (acesse como `/admin?token=SUA_SENHA`).

## 2. Teste local

Requer Node.js 20+.

```bash
npm install
```

```bash
export TMDB_API_KEY="SUA_NOVA_CHAVE"
npm start
```

Abra:

- `http://localhost:10000/manifest.json`
- `http://localhost:10000/admin`

## 3. Publicar no GitHub

1. Envie `server.js`, `package.json`, `addons.json`, `render.yaml`, `README.md` para o repositório.
2. Não envie `.env` nem a chave TMDB.

## 4. Publicar no Render

1. New > Web Service, conecte o repositório.
2. Runtime: Node. Build: `npm install`. Start: `npm start`.
3. Environment Variables:
   - `TMDB_API_KEY`: sua chave TMDB.
   - `ADMIN_TOKEN` (opcional): senha para proteger `/admin`.
4. Deploy.

Manifesto: `https://NOME-DO-SERVICO.onrender.com/manifest.json`

## 5. Instalar no Stremio

Cole a URL do `manifest.json` na tela de instalação de addon por URL. Remova addons individuais que já estão cobertos pelo agregador para evitar catálogos duplicados na lista de dropdowns do Stremio (isso é um comportamento nativo do app e não pode ser controlado pelo addon).

## Limitações conhecidas

- Cada fonte contribui só com a **primeira página** do catálogo dela na mesclagem; `skip` além disso pagina sobre o conjunto já mesclado (não busca páginas adicionais de cada fonte). Suficiente para navegação normal, mas listas muito longas de uma fonte específica podem não aparecer inteiras.
- Fontes que só oferecem `stream` (ex. Torrentio, ThePirateBay, CineTorrent) não têm catálogo próprio — elas não entram na agregação de descoberta, só fornecem fontes de vídeo quando você assiste algo (isso é normal e esperado).
- Algumas das URLs enviadas podem estar fora do ar ou mudar de formato sem aviso; erros de fontes individuais aparecem no `/admin` e não derrubam o restante do agregador.

## Segurança da chave

Nunca coloque a TMDB API key no código ou no GitHub. Sempre por variável de ambiente.
