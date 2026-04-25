/**
 * UNIFIQUE — Backend de Scraping + Pix
 * Deploy: Render.com (Node.js)
 * npm install express puppeteer-core @sparticuz/chromium axios cors
 */

const express   = require('express');
const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');
const axios     = require('axios');
const cors      = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const SIGILO_API_KEY = process.env.SIGILO_API_KEY;
const PORT           = process.env.PORT || 3000;

// ── HELPER: lança browser ──
async function launchBrowser() {
  return puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 800 },
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

// ── HELPER: digita em campo usando vários seletores ──
async function typeInField(page, seletores, valor) {
  for (const sel of seletores) {
    try {
      await page.waitForSelector(sel, { timeout: 4000, visible: true });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, valor, { delay: 50 });
      console.log('Campo preenchido:', sel);
      return true;
    } catch (_) {}
  }
  return false;
}

// ── HELPER: clica em botão ──
async function clickButton(page, seletores) {
  for (const sel of seletores) {
    try {
      await page.waitForSelector(sel, { timeout: 3000, visible: true });
      await page.click(sel);
      console.log('Botão clicado:', sel);
      return true;
    } catch (_) {}
  }
  // Fallback: busca por texto
  const textos = ['Continuar', 'Entrar', 'Confirmar', 'Próximo', 'Avançar', 'Acessar'];
  for (const texto of textos) {
    try {
      const clicou = await page.evaluate((t) => {
        const el = [...document.querySelectorAll('button, [role="button"]')]
          .find(e => e.innerText?.trim().toLowerCase().includes(t.toLowerCase()));
        if (el) { el.click(); return true; }
        return false;
      }, texto);
      if (clicou) { console.log('Botão clicado por texto:', texto); return true; }
    } catch (_) {}
  }
  return false;
}

// ── HELPER: aguarda transição de página ──
async function aguardar(page, ms = 2000) {
  await new Promise(r => setTimeout(r, ms));
}

// ── HELPER: extrai faturas do DOM ──
async function extrairFaturas(page) {
  return page.evaluate(() => {
    const faturas = [];
    const vistas  = new Set();
    const reValor = /R\$\s*([\d.]+,\d{2})/g;
    const reData  = /(\d{2}\/\d{2}\/\d{4})/g;

    const candidatos = document.querySelectorAll(
      'tr, li, .card, .item, .fatura, .invoice, .boleto, ' +
      '[class*="fatura"], [class*="invoice"], [class*="boleto"], [class*="charge"], [class*="bill"]'
    );

    candidatos.forEach(el => {
      const texto = el.innerText || '';
      if (texto.length < 5 || texto.length > 2000) return;
      const valores = [...texto.matchAll(reValor)].map(m => m[1]);
      const datas   = [...texto.matchAll(reData)].map(m => m[1]);
      if (!valores.length || !datas.length) return;
      const chave = valores[0] + datas[0];
      if (vistas.has(chave)) return;
      vistas.add(chave);
      const valorNum = parseFloat(valores[0].replace(/\./g, '').replace(',', '.'));
      if (valorNum < 1 || valorNum > 99999) return;
      const textoLower = texto.toLowerCase();
      let status = 'em aberto';
      if (textoLower.includes('pago') || textoLower.includes('quitado')) status = 'pago';
      else if (textoLower.includes('vencido') || textoLower.includes('atrasado')) status = 'vencido';
      const reRef = /(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*[\s\/\-]*\d{4}/i;
      const refMatch = texto.match(reRef);
      faturas.push({
        valor: valorNum.toFixed(2),
        vencimento: datas[0],
        referencia: refMatch ? refMatch[0] : datas[0],
        status,
      });
    });

    // Fallback: varre texto completo
    if (faturas.length === 0) {
      const paginaTexto = document.body.innerText;
      const vs = [...paginaTexto.matchAll(reValor)].map(m => m[1]);
      const ds = [...paginaTexto.matchAll(reData)].map(m => m[1]);
      const usados = new Set();
      vs.forEach((v, i) => {
        const d = ds[i] || ds[0];
        if (!d) return;
        const chave = v + d;
        if (usados.has(chave)) return;
        usados.add(chave);
        const valorNum = parseFloat(v.replace(/\./g, '').replace(',', '.'));
        if (valorNum < 1 || valorNum > 99999) return;
        faturas.push({ valor: valorNum.toFixed(2), vencimento: d, referencia: d, status: 'em aberto' });
      });
    }

    return faturas;
  });
}

// ─────────────────────────────────────────────────────────────
// ROTA: POST /consultar-debito
// ─────────────────────────────────────────────────────────────
app.post('/consultar-debito', async (req, res) => {
  const { cpf, telefone } = req.body;
  if (!cpf || !telefone) return res.status(400).json({ erro: 'CPF e telefone são obrigatórios.' });

  const cpfLimpo = cpf.replace(/\D/g, '');
  const telLimpo = telefone.replace(/\D/g, '');
  const cpfFmt   = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  const telFmt   = telLimpo.length === 11
    ? telLimpo.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3')
    : telLimpo.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Intercepta respostas JSON com faturas
    let faturasDeAPI = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        const ct  = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        if (!/fatura|invoice|boleto|charge|bill|payment|debito|financ/i.test(url)) return;
        const json = await response.json().catch(() => null);
        if (!json) return;
        const lista = Array.isArray(json) ? json : (json.data || json.faturas || json.items || []);
        if (!Array.isArray(lista) || !lista.length) return;
        lista.forEach(item => {
          const valor = item.valor || item.amount || item.value || item.total;
          const venc  = item.vencimento || item.due_date || item.dueDate || item.dataVencimento;
          if (valor && venc) {
            faturasDeAPI.push({
              valor: parseFloat(String(valor).replace(/[^\d.,]/g, '').replace(',', '.')).toFixed(2),
              vencimento: venc,
              referencia: item.referencia || item.description || venc,
              status: String(item.status || '').toLowerCase().includes('pago') ? 'pago' : 'em aberto',
            });
          }
        });
      } catch (_) {}
    });

    // ── 1. Abrir login ──
    console.log('Abrindo portal...');
    await page.goto('https://minhafatura.unifique.com.br/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await aguardar(page, 2000);

    // ── 2. CPF ──
    console.log('Preenchendo CPF:', cpfFmt);
    await typeInField(page, [
      'input[name="cpf"]', 'input[id="cpf"]',
      'input[placeholder*="CPF"]', 'input[placeholder*="cpf"]',
      'input[placeholder*="documento"]', 'input[placeholder*="Documento"]',
      'input[type="tel"]', 'input[type="text"]', 'input',
    ], cpfFmt);

    // ── 3. Continuar ──
    await clickButton(page, ['button[type="submit"]', 'button.btn-primary', 'button[class*="primary"]', 'input[type="submit"]']);
    await aguardar(page, 3000);

    // ── 4. Telefone ──
    console.log('Preenchendo telefone:', telFmt);
    await typeInField(page, [
      'input[name="telefone"]', 'input[name="phone"]', 'input[name="celular"]',
      'input[id="telefone"]', 'input[placeholder*="telefone"]', 'input[placeholder*="Telefone"]',
      'input[placeholder*="celular"]', 'input[placeholder*="Celular"]', 'input[placeholder*="phone"]',
      'input[type="tel"]', 'input[type="text"]',
    ], telFmt);

    // ── 5. Confirmar ──
    await clickButton(page, ['button[type="submit"]', 'button.btn-primary', 'button[class*="primary"]', 'input[type="submit"]']);
    await aguardar(page, 5000);

    // ── 6. Extrair faturas ──
    let faturas = faturasDeAPI.length > 0 ? faturasDeAPI : await extrairFaturas(page);

    // Remove duplicatas
    const vistos = new Set();
    faturas = faturas.filter(f => {
      const k = f.valor + f.vencimento;
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });

    console.log('Faturas encontradas:', faturas.length);
    await browser.close();
    return res.json({ sucesso: true, faturas });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Erro scraping:', err.message);
    return res.status(500).json({ erro: 'Não foi possível consultar o débito.', detalhe: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ROTA: POST /gerar-pix  (Sigilo Pay)
// ─────────────────────────────────────────────────────────────
app.post('/gerar-pix', async (req, res) => {
  const { valor, cpf, nome, descricao, email, telefone } = req.body;
  if (!valor || !cpf) return res.status(400).json({ erro: 'Valor e CPF são obrigatórios.' });

  const PUBLIC_KEY = process.env.SIGILO_CLIENT_ID;
  const SECRET_KEY = process.env.SIGILO_CLIENT_SECRET;

  // Valida email antes de chamar a API
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emailValido = emailRegex.test(email) ? email : null;
  if (!emailValido) {
    return res.status(400).json({ erro: 'E-mail inválido. Informe um e-mail no formato nome@dominio.com' });
  }

  // Identificador único por transação
  const identifier = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const PRODUTO_ID = 'cmoej2rdj0kt41yrxf9n1mhxf';
  const OFFER_CODE = 'WVR6DMH';

  const body = {
    identifier,
    amount:   parseFloat(valor),
    offerCode: OFFER_CODE,
    client: {
      name:     nome     || 'Cliente Unifique',
      email:    emailValido,
      phone:    telefone || '(47) 99999-9999',
      document: cpf.replace(/\D/g, ''),
    },
    products: [
      {
        id:       PRODUTO_ID,
        quantity: 1,
        price:    parseFloat(valor),
      }
    ],
    metadata: {
      plano:    descricao || 'Serviço Unifique',
      provider: 'Unifique Site',
    },
  };

  console.log('Body enviado:', JSON.stringify(body));

  try {
    const response = await axios.post(
      'https://app.sigilopay.com.br/api/v1/gateway/pix/receive',
      body,
      {
        headers: {
          'x-public-key':  PUBLIC_KEY,
          'x-secret-key':  SECRET_KEY,
          'Content-Type':  'application/json',
        },
        timeout: 20000,
      }
    );

    const d = response.data;
    console.log('Resposta Sigilo Pay:', JSON.stringify(d));

    return res.json({
      sucesso:       true,
      pixCopiaECola: d?.pix?.code   || null,
      qrCodeBase64:  d?.pix?.base64 || null,
      qrCodeUrl:     d?.pix?.image  || null,
      txid:          d?.transactionId || null,
      status:        d?.status || null,
    });

  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('Sigilo Pay erro:', JSON.stringify(errData));
    return res.status(500).json({
      erro:    'Não foi possível gerar o Pix.',
      detalhe: errData,
      status:  err.response?.status,
    });
  }
});

// ─────────────────────────────────────────────────────────────
// ROTA: GET / — health check
// ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', servico: 'Unifique Scraping API' }));

app.listen(PORT, () => console.log('Servidor rodando na porta', PORT));
