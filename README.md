# MarketScan — Rastreador de Oportunidades no Facebook Marketplace

Ferramenta web para buscar anúncios no Facebook Marketplace, calcular médias de preço e identificar automaticamente as melhores oportunidades.

## Como funciona

1. Usuário abre o app e clica em **Conectar Facebook**
2. Uma janela do Facebook abre — o usuário faz login normalmente
3. O app detecta o login e libera a busca
4. O usuário busca por palavra-chave e a ferramenta exibe os anúncios com análise de preços

> As credenciais nunca passam pelo servidor. O login é feito diretamente no Facebook pelo próprio usuário.

---

## Instalação

### Pré-requisitos
- Node.js 18+ ([nodejs.org](https://nodejs.org))
- Google Chrome instalado (usado pelo Puppeteer)

### Passo a passo

```bash
# 1. Clone ou baixe o projeto
cd marketplace-tracker

# 2. Instale as dependências
npm install

# 3. Copie o .env de exemplo
cp .env.example .env

# 4. Inicie o servidor
npm start
```

Acesse: **http://localhost:3000**

---

## Estrutura do projeto

```
marketplace-tracker/
├── backend/
│   ├── server.js      → API Express (rotas)
│   ├── scraper.js     → Puppeteer (coleta de anúncios)
│   └── database.js    → SQLite (armazenamento)
├── frontend/
│   └── index.html     → Interface web completa
├── data/              → Banco de dados (criado automaticamente)
├── .env.example
└── package.json
```

---

## API

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/session/start` | Abre janela de login do Facebook |
| GET | `/api/session/:id/check` | Verifica se login foi feito |
| DELETE | `/api/session/:id` | Encerra sessão |
| POST | `/api/search` | Busca anúncios |
| GET | `/api/search/:id` | Retorna busca salva |
| GET | `/api/session/:id/history` | Histórico de buscas |

---

## Lógica de oportunidades

- Calcula a **média de preços** dos anúncios coletados
- Marca como **oportunidade** todo anúncio com preço ≤ 70% da média
- Exibe o percentual abaixo/acima da média em cada card

---

## Deploy em servidor (produção)

Recomendado: **Railway** ou **Render**

```bash
# Variáveis de ambiente necessárias:
PORT=3000

# Atenção: em servidores headless, o Puppeteer precisa de:
# --no-sandbox (já configurado no código)
# Chrome/Chromium instalado no servidor
```

Para Railway/Render, adicione no package.json:
```json
"scripts": {
  "start": "node backend/server.js"
}
```

---

## Próximas funcionalidades planejadas

- [ ] Alertas por email quando aparecer oportunidade
- [ ] Histórico de preços por produto
- [ ] Comparação de buscas
- [ ] Filtro por raio de distância
- [ ] Exportar resultados em CSV
- [ ] Múltiplos usuários com autenticação própria
