/**
 * UNIFIQUE — Backend de Scraping + Pix
 * Subir no Railway.app (Node.js)
 *
 * Instalar dependências:
 *   npm install express puppeteer-core @sparticuz/chromium axios cors
 */

const express    = require('express');
const puppeteer  = require('puppeteer-core');
const chromium   = require('@sparticuz/chromium');
const axios      = require('axios');
const cors       = require('cors');

const app  = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // Em produção, troque '*' pelo domínio do seu site

const SIGILO_API_KEY = process.env.SIGILO_API_KEY; // Coloque no Railway como variável de ambiente
const PORT           = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// ROTA: Consultar débito pelo CPF
// POST /consultar-debito
// Body: { cpf: "05145633971", telefone: "47992317571" }
// ─────────────────────────────────────────────
app.post('/consultar-debito', async (req, res) => {
  const { cpf, telefone } = req.body;

  if (!cpf || !telefone) {
    return res.status(400).json({ erro: 'CPF e telefone são obrigatórios.' });
  }

  const cpfLimpo  = cpf.replace(/\D/g, '');
  const telLimpo  = telefone.replace(/\D/g, '');

  let browser;
  try {
    browser = await puppeteer.launch({
      args:            chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath:  await chromium.executablePath(),
      headless:        chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 1. Acessar o portal
    await page.goto('https://minhafatura.unifique.com.br/login', {
      waitUntil: 'networkidle2',
      timeout:   30000,
    });

    // 2. Preencher o CPF
    // ⚠️ Ajuste os seletores abaixo conforme os campos reais do portal
    await page.waitForSelector('input[name="cpf"], input[placeholder*="CPF"], input[type="text"]', { timeout: 10000 });
    await page.type('input[name="cpf"], input[placeholder*="CPF"], input[type="text"]', cpfLimpo, { delay: 60 });

    // 3. Clicar em continuar / próximo
    await page.click('button[type="submit"], button:contains("Continuar"), button:contains("Entrar")');

    // 4. Aguardar campo de telefone
    await page.waitForSelector('input[name="telefone"], input[placeholder*="telefone"], input[placeholder*="celular"]', { timeout: 10000 });
    await page.type('input[name="telefone"], input[placeholder*="telefone"], input[placeholder*="celular"]', telLimpo, { delay: 60 });

    // 5. Confirmar login
    await page.click('button[type="submit"], button:contains("Confirmar"), button:contains("Entrar")');

    // 6. Aguardar a página de faturas carregar
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

    // 7. Extrair dados das faturas
    // ⚠️ Ajuste os seletores conforme o HTML real do portal após login
    const faturas = await page.evaluate(() => {
      const itens = [];

      // Tenta capturar elementos comuns de listagem de faturas
      const rows = document.querySelectorAll(
        '.fatura, .invoice, .boleto, [class*="fatura"], [class*="invoice"], tr, .card'
      );

      rows.forEach(row => {
        const texto = row.innerText || '';
        // Busca por padrão de valor monetário
        const valorMatch     = texto.match(/R\$\s?([\d.,]+)/);
        const vencimentoMatch = texto.match(/(\d{2}\/\d{2}\/\d{4})/);

        if (valorMatch && vencimentoMatch) {
          itens.push({
            valor:      valorMatch[1].replace('.', '').replace(',', '.'),
            vencimento: vencimentoMatch[1],
            status:     texto.toLowerCase().includes('pago') ? 'pago' : 'em aberto',
            codigoBarras: null, // Implementar se necessário
          });
        }
      });

      return itens;
    });

    await browser.close();

    if (faturas.length === 0) {
      return res.json({ sucesso: true, faturas: [], mensagem: 'Nenhuma fatura encontrada.' });
    }

    return res.json({ sucesso: true, faturas });

  } catch (err) {
    if (browser) await browser.close();
    console.error('Erro no scraping:', err.message);
    return res.status(500).json({ erro: 'Não foi possível consultar o débito. Tente novamente.', detalhe: err.message });
  }
});

// ─────────────────────────────────────────────
// ROTA: Gerar Pix via Sigilo Pay
// POST /gerar-pix
// Body: { valor: "89.90", cpf: "05145633971", nome: "João Silva", descricao: "Fatura Unifique" }
// ─────────────────────────────────────────────
app.post('/gerar-pix', async (req, res) => {
  const { valor, cpf, nome, descricao } = req.body;

  if (!valor || !cpf) {
    return res.status(400).json({ erro: 'Valor e CPF são obrigatórios.' });
  }

  try {
    // ⚠️ Ajuste o endpoint e o formato conforme a documentação da Sigilo Pay
    const response = await axios.post(
      'https://api.sigilopay.com.br/v1/pix/cobranca', // Confirme a URL correta na doc da Sigilo Pay
      {
        valor:     parseFloat(valor),
        pagador: {
          cpf:  cpf.replace(/\D/g, ''),
          nome: nome || 'Cliente',
        },
        descricao: descricao || 'Pagamento de fatura Unifique',
      },
      {
        headers: {
          'Authorization': `Bearer ${SIGILO_API_KEY}`,
          'Content-Type':  'application/json',
        },
      }
    );

    const dados = response.data;

    return res.json({
      sucesso:      true,
      pixCopiaECola: dados.pixCopiaECola || dados.qr_code        || dados.payload,
      qrCodeBase64:  dados.qrCodeBase64  || dados.qr_code_base64 || null,
      txid:          dados.txid          || dados.id              || null,
      expiracao:     dados.expiracao     || dados.expires_at      || null,
    });

  } catch (err) {
    console.error('Erro Sigilo Pay:', err.response?.data || err.message);
    return res.status(500).json({
      erro:    'Não foi possível gerar o Pix.',
      detalhe: err.response?.data || err.message,
    });
  }
});

// ─────────────────────────────────────────────
// ROTA: Health check
// ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', servico: 'Unifique Scraping API' }));

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
