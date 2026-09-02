# Cinemeta PT-BR

Addon para Stremio baseado no Cinemeta.

## Recursos

- Proxy de metadados do Cinemeta.
- Sinopse preferencialmente obtida do TMDB em `pt-BR`.
- Fallback para tradução automática da sinopse quando o TMDB não possui overview localizado.
- Preferência por pôster com idioma português no TMDB; fallback para pôster sem idioma/original.
- Catálogos Popular, Featured e New para filmes e séries.
- Filtros combináveis: `Ano`, `Gênero`, `Busca` e `skip`.
- Cache em memória para reduzir chamadas ao TMDB e ao serviço de tradução.
- Chave TMDB somente por variável de ambiente.

## IMPORTANTE SOBRE O FILTRO ANO

O manifest declara `year` como extra opcional. O backend aplica o ano junto dos demais critérios.

Exemplos conceituais:

- Ano=2024 -> somente itens de 2024.
- Ano=2024 + Gênero=Action -> somente ação de 2024.
- Ano=2024 + Busca=Batman -> pesquisa filtrada por 2024.
- Sem Ano -> comportamento padrão do catálogo.

A forma como cada cliente Stremio expõe filtros pode variar. O SDK oficial documenta `extra` para busca, filtragem e paginação.

## 1. Teste local

Requer Node.js 20+.

```bash
npm install
```

Defina a chave:

Windows PowerShell:
```powershell
$env:TMDB_API_KEY="SUA_NOVA_CHAVE"
npm start
```

Linux/macOS:
```bash
export TMDB_API_KEY="SUA_NOVA_CHAVE"
npm start
```

Abra:

`http://localhost:10000/manifest.json`

## 2. Publicar no GitHub

1. Crie um repositório novo no GitHub, por exemplo `cinemeta-ptbr`.
2. Envie todos os arquivos deste projeto.
3. Não envie `.env` nem a chave TMDB.
4. O arquivo `render.yaml` já contém uma configuração básica para Render.

## 3. Publicar no Render

1. Acesse o Render.
2. Escolha **New > Web Service**.
3. Conecte seu GitHub.
4. Selecione o repositório.
5. Runtime: Node.
6. Build Command: `npm install`.
7. Start Command: `npm start`.
8. Em Environment Variables, crie:
   - Key: `TMDB_API_KEY`
   - Value: sua nova chave TMDB.
9. Faça o deploy.

O Render fornecerá uma URL HTTPS, normalmente:

`https://NOME-DO-SERVICO.onrender.com`

O manifesto ficará em:

`https://NOME-DO-SERVICO.onrender.com/manifest.json`

## 4. Instalar no Stremio

Copie a URL HTTPS terminada em:

`/manifest.json`

No Stremio, abra a área de addons, escolha instalar addon por URL e cole o endereço.

## 5. Teste recomendado

Depois de instalar:

1. Remova o Cinemeta original para evitar conflito de fornecedor de metadados.
2. Abra um filme conhecido.
3. Confira a sinopse.
4. Confira o pôster.
5. Abra os catálogos.
6. Teste Ano sozinho.
7. Teste Ano + Gênero.
8. Teste Ano + Busca.

## Segurança da chave

Nunca coloque a TMDB API key no código ou no GitHub.

Como uma chave anterior foi exposta durante os testes, gere/rotacione uma nova chave antes de publicar.

## Observação sobre agregação de catálogos

Este projeto reproduz os catálogos do Cinemeta; ele não tenta juntar automaticamente os catálogos de todos os outros addons instalados no Stremio. O Stremio trata os catálogos de cada addon separadamente. Um agregador de catálogos é um projeto diferente e pode ser acrescentado depois.
