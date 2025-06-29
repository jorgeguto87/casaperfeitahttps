const https = require('https');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
const PORT = 3060;

app.use(cors({
  origin: 'https://atentus.com.br',
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));


//credenciais ssl
const credentials = {
    key: fs.readFileSync('/etc/letsencrypt/live/atentus.com.br/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/atentus.com.br/fullchain.pem')
};

const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let qrBase64 = '';
let isConnected = false;
let client;

const diaMap = {
  1: 'segunda',
  2: 'terca',
  3: 'quarta',
  4: 'quinta',
  5: 'sexta',
  6: 'sabado'
};

const imagemMap = {
  1: 'diaum',
  2: 'diadois',
  3: 'diatres',
  4: 'diaquatro',
  5: 'diacinco',
  6: 'diaseis'
};

const feriados = [
  '01-18', '04-21', '05-01', '09-07',
  '10-12', '11-02', '11-15'
];
const anonovo = '01-01';
const Natal = '12-25';
const Carnaval = ['03-01', '03-02', '03-03', '03-04', '03-05'];
const Pascoa = '04-20';

let chatbotAtivo = true;

function lerHorarios() {
  const filePath = path.join(__dirname, 'horarios.txt');
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const horariosOriginais = content.split(',').map(h => parseInt(h.trim())).filter(h => !isNaN(h));

  // Converte cada horário para +3 %24
  const horariosConvertidos = horariosOriginais.map(hora => (hora + 3) % 24);

  console.log('📋 Horários do arquivo:', horariosOriginais);
  console.log('🔄 Horários convertidos (+3):', horariosConvertidos);

  return horariosConvertidos;
}


function contatosFiltrados() {
    const filePath = path.join(__dirname, 'internos.txt');
    
    if (!fs.existsSync(filePath)) {
        return [];
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    
    return content.split('\n')
        .map(linha => linha.trim())
        .filter(linha => linha.length > 0); // Remove linhas vazias
}

function lerGruposDestinatarios() {
  const filePath = path.join(__dirname, 'grupos_check.txt');
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(l => l.split('|')[0]?.trim())
    .filter(id => id && id.endsWith('@g.us'));
}


function lerMensagensDataTxt() {
  const filePath = path.join(__dirname, 'data.txt');
  if (!fs.existsSync(filePath)) return {};
  const linhas = fs.readFileSync(filePath, 'utf-8').split('\n');
  const mapa = {};
  for (const linha of linhas) {
    const [dia, ...msg] = linha.split(':');
    if (dia && msg.length > 0) {
      mapa[dia.trim()] = msg.join(':').trim().replace(/\\n/g, '\n');
    }
  }
  return mapa;
}

async function startClient() {
client = new Client({
  authStrategy: new LocalAuth({ clientId: 'atentusadv' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-client-side-phishing-detection',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update'
    ]
  }
});


  client.on('qr', async qr => {
    qrBase64 = await qrcode.toDataURL(qr);
    isConnected = false;
    console.log('📲 Novo QR Code gerado.');
  });

  client.on('ready', () => {
    isConnected = true;
    console.log('✅ Chatbot conectado com sucesso!');
    escutarGrupos(client);
    chatBot(client);
    agendarEnvios();
  });

  client.on('disconnected', () => {
    isConnected = false;
    console.log('❌ Cliente desconectado.');
  });

  await client.initialize();
}

startClient();



async function restartClient() {
  if (client) await client.destroy();
  await startClient();
}

async function logoutClient() {
  if (client) {
    await client.logout();
    await client.destroy();
  }
  const sessionPath = path.join(__dirname, '.wwebjs_auth', 'atentusadv');
  if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
  isConnected = false;
  await startClient();
}

function escutarGrupos(client) {
  client.on('message', async msg => {
    const from = msg.from;
    if (from.endsWith('@g.us')) {
      const chat = await msg.getChat();
      const nomeGrupo = chat.name;
      const registro = `${from} - ${nomeGrupo}`;
      const arquivo = path.join(__dirname, 'grupos_scan.txt');
      const existente = fs.existsSync(arquivo) ? fs.readFileSync(arquivo, 'utf-8') : '';
      if (!existente.includes(from)) {
        fs.appendFileSync(arquivo, registro + '\n', 'utf-8');
        console.log(`📁 Grupo salvo: ${registro}`);
      }
    }
  });
}

function agendarEnvios() {
  console.log('📅 Função de agendamento registrada');
  let enviadosHoje = new Set();

  cron.schedule('0 * * * *', async () => {
    console.log('🕒 Agendamento ativado!');
    const agora = new Date();
    const hora = agora.getHours();
    function diaSemana() {
      let day = agora.getDay();
      if (hora >= 0 && hora <= 1){
        day = day - 1;
        if (day < 0){
          day = 6;
        }
      }else{
        day = day;
      }
      return day;
    }
    const dia = diaSemana(); // 0 = domingo

    console.log(`📆 Dia: ${dia} | Hora: ${hora}`);

    if (dia === 0) {
      console.log('⛔ Domingo. Nenhum envio será feito.');
      return;
    }

    const horarios = lerHorarios();
    console.log('📂 Horários cadastrados:', horarios);

    if (!horarios.includes(hora)) {
      console.log(`⏱️ Hora ${hora} não está nos horários programados.`);
      return;
    }

    const chaveEnvio = `${dia}-${hora}`;
    if (enviadosHoje.has(chaveEnvio)) {
      console.log('🔁 Já enviado neste horário. Ignorando...');
      return;
    }

    const nomeImagemBase = imagemMap[dia];
    const nomeMensagem = diaMap[dia];

        if (!nomeImagemBase || !nomeMensagem) {
      console.log('⚠️ Dia não mapeado corretamente:', dia);
      return;
    }

    const mensagemMap = lerMensagensDataTxt();
    console.log('📜 Mapa de mensagens:', mensagemMap);

    const texto = mensagemMap[nomeMensagem];
    console.log(`📄 Texto para ${nomeMensagem}:`, texto);

    const exts = ['.jpg', '.png'];
    let caminhoImagem = null;
    let imagemExt = '';

    for (const ext of exts) {
      const tentativa = path.join(assetsDir, `${nomeImagemBase}${ext}`);
      if (fs.existsSync(tentativa)) {
        caminhoImagem = tentativa;
        imagemExt = ext;
        break;
      }
    }

    if (!caminhoImagem) {
      console.log(`🖼️ Imagem não encontrada para ${nomeImagemBase}` );
    } else {
      console.log(`🖼️ Imagem encontrada: ${caminhoImagem}` );
    }

    if (!caminhoImagem || !texto) {
      console.log(`⚠️ Conteúdo incompleto para ${nomeMensagem.toUpperCase()}. Imagem ou texto ausente.`);
      return;
    }

    try {
      const media = MessageMedia.fromFilePath(caminhoImagem);
      const grupos = lerGruposDestinatarios();
      console.log(`📣 Enviando para grupos:, \n${grupos}`);

      for (const grupoId of grupos) {
        try {
          await client.sendMessage(grupoId, media, { caption: texto });
          await new Promise(resolve => setTimeout(resolve, 2000));
          console.log(`✅ Mensagem enviada para ${grupoId} (${nomeMensagem})`);
        } catch (erroEnvio) {
          console.error(`❌ Erro ao enviar para ${grupoId}:`, erroEnvio.message);
        }
      }

      enviadosHoje.add(chaveEnvio); // marca como enviado
    } catch (erroGeral) {
      console.error(`❌ Erro no processo de envio para ${nomeMensagem}:`, erroGeral.message);
    }
  });
}

//chatbot
function chatBot(client){
  function saudacao() {
    const data = new Date();
    const hora = data.getHours();
    let str = '';
    if (hora >= 6 && hora < 12) {
        str = '*Bom Diaa! 🌞*';
    } else if (hora >= 12 && hora < 18) {
        str = '*Boa Tarde! 🌄*';
    } else {
        str = '*Boa Noite! 🌙*';
    }
    return str;
};

function feriado() {
    const hoje = new Date();
    const dataAtual = `${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    return feriados.includes(dataAtual);
};

function natal() {
    const hoje = new Date();
    const dataAtual = `${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    return Natal === dataAtual;
};

function reveilon() {
    const hoje = new Date();
    const dataAtual = `${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    return anonovo === dataAtual;
};

function carnaval() {
    const hoje = new Date();
    const dataAtual = `${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    return Carnaval.includes(dataAtual);
};

function pascoa() {
    const hoje = new Date();
    const dataAtual = `${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
    return Pascoa === dataAtual;
};

function atendente() {
    const hoje = new Date();
    const hora = hoje.getHours();
    const dia = hoje.getDay();
    let str = '';
    if (dia <= 5 && dia >= 1 && hora >= 8 && hora < 19) {
        str = '😃 Aguarde um momento que logo será atendido.';
    } else if (dia === 6 && hora >= 8 && hora < 14) {
        str = '😃 Aguarde um momento que logo será atendido.';
    } else if (dia === 6 && hora >= 14) {
        str = '🏖️ *Aproveite o fim de semana!*\n\n😃 Entraremos em contato assim que possível.\n\n🕗 _Nosso horário é de segunda a sexta de 09:00hs às 19:00hs e sábado de 09:00hs às 14:00hs._\n\n*Atendimento presencial mediante agendamento.*';
    } else if (dia === 0) {
        str = '🏖️ *Aproveite o fim de semana!*\n\n😃 Entraremos em contato assim que possível.\n\n🕗 _Nosso horário é de segunda a sexta de 09:00hs às 19:00hs e sábado de 09:00hs às 14:00hs._\n\n*Atendimento presencial mediante agendamento.*';
    } else if (feriado()) {
        str = '🏖️ *Aproveite o feriado!*\n\n😃 Entraremos em contato assim que possível.\n\n🕗 _Nosso horário é de segunda a sexta de 09:00hs às 19:00hs e sábado de 09:00hs às 14:00hs._\n\n*Atendimento presencial mediante agendamento.*';
    } else if (reveilon()) {
        str = '🥂 *FELIZ ANO NOVO!* 🍾\n\n😃 Entraremos em contato assim que possível.\n\n🕗 _Nosso horário é de segunda a sexta de 09:00hs às 19:00hs e sábado de 09:00hs às 14:00hs._\n\n*Atendimento presencial mediante agendamento.*';
    } else if (natal()) {
        str = '🎅 *FELIZ NATAL!* 🎄\n\n😃 Entraremos em contato assim que possível.\n\n🕗 _Nosso horário é de segunda a sexta de 09:00hs às 19:00hs e sábado de 09:00hs às 14:00hs._\n\n*Atendimento presencial mediante agendamento.*';
    } else if (carnaval()) {
        str = '🎭 *FELIZ CARNAVAL!* 🎉\n\n😃 Entraremos em contato assim que possível.\n\n🕗 _Nosso horário é de segunda a sexta de 09:00hs às 19:00hs e sábado de 09:00hs às 14:00hs._\n\n*Atendimento presencial mediante agendamento.*';
    } else if (pascoa()) {
        str = '🍫 *FELIZ PÁSCOA!* 🐇\n\n😃 Entraremos em contato assim que possível.\n\n🕗 _Nosso horário é de segunda a sexta de 09:00hs às 19:00hs e sábado de 09:00hs às 14:00hs._\n\n*Atendimento presencial mediante agendamento.*';
    } else {
        str = 'Humm... \n😌 Já estamos fora do horário de atendimento.\n\n😃 Mas não se preocupe, retornaremos assim que possível!\n\n🕗 _Nosso horário é de segunda a sexta de 09:00hs às 19:00hs e sábado de 09:00hs às 14:00hs._\n\n*Atendimento presencial mediante agendamento.*';
    }
    return str;
};

function deveIgnorarMensagem(msg, internos) {
    const from = msg.from;
    if (internos.includes(from)) return true;
    return false;
}


const delay = ms => new Promise(res => setTimeout(res, ms));
async function fimAtendimento(chat) {
    await chat.sendMessage('😊 Nosso atendimento está finalizado!');
}
   
const state = {};

client.on('message', async (msg) => {  
  if (!chatbotAtivo) return;

  if (msg.from.endsWith('@g.us')) return;

  const internos = contatosFiltrados();
  if (deveIgnorarMensagem(msg, internos)) return;
        
    const from = msg.from;
    const mensagem = msg.body || msg.from.endsWith('@c.us');   
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const name = contact.pushname;
    const MAX_ATTEMPTS = 3;
    if (!state[from]) state[from] = { step: 0, attempts: 0 };
    const userState = state[from];
        
        const saudacoes = ['oi', 'bom dia', 'boa tarde', 'olá', 'Olá', 'Oi', 'Boa noite', 'Bom Dia', 'Bom dia', 'Boa Tarde', 'Boa tarde', 'Boa Noite', 'boa noite'];
        const catalogo = MessageMedia.fromFilePath('./catalogo_de_cores_casa_perfeita.pdf');
        if (userState.step === 0) {
            if (saudacoes.some(palavra => msg.body.includes(palavra))) {
                state.step = "mainMenu";
                const logo = MessageMedia.fromFilePath('./logo.jpg');
                await delay(3000);
                await chat.sendStateTyping();
                await delay(3000);
                await client.sendMessage(msg.from, logo, { caption: `🙋‍♂️ *Olá, ${name}!* ${saudacao()}\n\nSou o Rodrigo, assistente virtual da *Casa Perfeita Planejados.*\n_Como posso ajudar?_\n\nDigite o *NÚMERO* de uma das opções abaixo:\n1️⃣ - Realizar projeto\n2️⃣ - Catálogo\n3️⃣ - Assistência técnica\n4️⃣ - Acompanhar entrega\n5️⃣ - Outros assuntos\n6️⃣ - Estou em atendimento` });
                state[from] = {step: 1};
                return;
        }
    } else if (userState.step === 1) {
        switch (mensagem) {
            case "1":
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, '😃 *Maravilha!*\n\n➡️ É sua primeira experiência em compra de planejados?\n\n#️⃣ - *SIM*\n0️⃣ - *NÃO*');
                state[from] = {step:2};
                return;
            case "2":
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, '😃 *Excelente escolha!*\n\nVocê vai se encantar com nossos catálogos incríveis!\n\n_Irei encaminhar para você._');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, 'Este aqui é o nosso catálogo de cores e acabamentos para você se encantar com nossas novidades. 👇');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, catalogo);
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, 'Vou encaminhar o link do nosso instagram.\nLá você também encontra ótimas idéias para o seu projeto além de acompanhar o nosso incrível trabalho.\n\nBasta acessar o link abaixo. 👇\n\nhttps://www.instagram.com/casaperfeitaplanejados?utm_source=ig_web_button_share_sheet&igsh=ZDNlZDc0MzIxNw==');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, '👋 *Até logo!*');
                delete state[from];
                break;
            case "3":
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, '😉 Entendi, você precisa de assistência técnica.\n\nPara isso irei pedir algumas informações que irão agilizar o seu atendimento. Ok?');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, 'Enquanto aguarda o atendente vou precisar:\n\n➡️ - *Nome completo, CPF ou número de contrato*\n➡️ - *Também preciso que nos envie um áudio relatando o problema com fotos ou um vídeo*');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, atendente());
                state [from] = {step:8};
                return;
            case "4":
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, '😃 *Que bom ter você como nosso cliente!*\n_Seu sonho está cada vez mais perto de ser realizado!_');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, 'Enquanto aguarda o seu atendimento irei precisar que informe:\n\n➡️ - *Nome completo, CPF ou número de contrato*');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, atendente());
                state [from] = {step:8};
                return;
            case "5":
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, '😉 *Certo, vamos falar sobre outros assuntos*\n\nVou te encaminhar para um de nossos atendentes e enquanto isso, fique a vontade para descrever o que precisa.');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, atendente());
                state [from] = {step:8};
                return;
            case "6":
                await delay(3000);
                await chat.sendStateTyping();
                await delay(3000);
                await client.sendMessage(msg.from, atendente());
                state [from] = {step:8};
                return;

                default:
                    if (userState.attempts === undefined) userState.attempts = 0;
                    userState.attempts++;
                    const tentativasRestantes = MAX_ATTEMPTS - userState.attempts;
                    if (userState.attempts >= MAX_ATTEMPTS) {
                        await client.sendMessage(
                            msg.from,
                            '❌ *Número de tentativas excedido!*\nAtendimento finalizado!\n\nDigite *Oi* para iniciar.'
                        );
                        state[from] = { step: 0, attempts: 0 };
                        delete state[from]; 
                    } else {
                        await client.sendMessage(
                            msg.from,
                            `❌ *Opção inválida!*\nVocê tem mais ${tentativasRestantes} tentativa(s).`
                        );
                    }
                    return;                
        }
    }



    else if(userState.step === 2) {
            switch (mensagem) {
                case "#":
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);    
                await client.sendMessage(msg.from, '😃 *Tudo bem, iremos te ajudar*\n\nSe puder preencher o nosso formulário de *briefing abaixo* vai nos ajudar muito a entender melhor sua necessidade. 👇\n\nhttps://casaperfeitaplanejados.com.br/?page_id=639');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, '➡️ É muito *importante* preencher todos os campos do formulário para nossa equipe conseguir desenvolver um projeto perfeito para você. 😃');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, 'Gostaria de preencher agora ou prefere dar continuidade para preencher em outro momento?\n\n#️⃣ - *PREENCHER AGORA*\n0️⃣ - *PREENCHER DEPOIS*');
                state[from] = {step: 3};
                break;

             case "0":
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);    
                await client.sendMessage(msg.from, '😃 *Perfeito!*\n\nSe puder preencher o nosso formulário de *briefing abaixo* vai nos ajudar muito a entender melhor sua necessidade. 👇\n\nhttps://casaperfeitaplanejados.com.br/?page_id=639');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, '➡️ É muito *importante* preencher todos os campos do formulário para nossa equipe conseguir desenvolver um projeto perfeito para você.');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, 'Gostaria de preencher agora ou prefere dar continuidade para preencher em outro momento?\n\n#️⃣ - *PREENCHER AGORA*\n0️⃣ - *PREENCHER DEPOIS*');
                state[from] = {step: 3};
                break;
                
                default:
                    if (userState.attempts === undefined) userState.attempts = 0;
                    userState.attempts++;
                    const tentativasRestantes = MAX_ATTEMPTS - userState.attempts;
                    if (userState.attempts >= MAX_ATTEMPTS) {
                        await client.sendMessage(
                            msg.from,
                            '❌ *Número de tentativas excedido!*\nAtendimento finalizado!\n\nDigite *Oi* para iniciar.'
                        );
                        state[from] = { step: 0, attempts: 0 };
                        delete state[from]; 
                    } else {
                        await client.sendMessage(
                            msg.from,
                            `❌ *Opção inválida!*\nVocê tem mais ${tentativasRestantes} tentativa(s).`
                        );
                    }
                    return;

                
            }       
            
        }else if(userState.step === 3) {
            switch (mensagem) {
                case "#":
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);    
                await client.sendMessage(msg.from, '😃 *Maravilha*\n\nVou aguardar o preenchimento do formulário para continuar com o seu atendimento.');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, '👋 *Até logo!*');
                state[from] = {step: 4};
                break;

             case "0":
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);    
                await client.sendMessage(msg.from, '😉 *Sem problemas!*\n\nVamos dar continuidade com o seu atendimento.');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, 'Você possui a planta ou imagens do ambiente?\n\nIsso irá nos ajudar bastante na construção do seu projeto. 😉\n\n8️⃣ - SIM\n9️⃣ - NÃO');
                state[from] = {step: 5};
                return;
                
                default:
                    if (userState.attempts === undefined) userState.attempts = 0;
                    userState.attempts++;
                    const tentativasRestantes = MAX_ATTEMPTS - userState.attempts;
                    if (userState.attempts >= MAX_ATTEMPTS) {
                        await client.sendMessage(
                            msg.from,
                            '❌ *Número de tentativas excedido!*\nAtendimento finalizado!\n\nDigite *Oi* para iniciar.'
                        );
                        state[from] = { step: 0, attempts: 0 };
                        delete state[from]; 
                    } else {
                        await client.sendMessage(
                            msg.from,
                            `❌ *Opção inválida!*\nVocê tem mais ${tentativasRestantes} tentativa(s).`
                        );
                    }
                    return;

                
            }       
            
        }
        
        else if (userState.step === 4) {
            const formRegex = ['Venho através do site', 'Disponibilidade de investimento', 'Olá, tudo bem?'];
            if (formRegex.some((word) => msg.body.includes(word))) {
                const audio = MessageMedia.fromFilePath('./audio_carol.mp3');
                await delay (3000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, `*😃 Maravilha, ${name}!*\n\nAgora que preencheu nosso formulário, irei encaminhar um áudio para te explicar como funciona o nosso trabalho.`);
                await delay (3000);
                await chat.sendStateRecording();
                await delay (10000);
                await client.sendMessage(msg.from, audio, {sendAudioAsVoice: true});
                await delay (90000);
                await chat.sendStateTyping();
                await delay (3000);
                await client.sendMessage(msg.from, 'Você possui a planta ou imagens do ambiente?\n\nIsso irá nos ajudar bastante na construção do seu projeto. 😉\n\n8️⃣ - SIM\n9️⃣ - NÃO');
                state[from] = {step: 5};
                return;
           
            
             } else{
                if (userState.attempts === undefined) userState.attempts = 0;
                userState.attempts++;
                const tentativasRestantes = MAX_ATTEMPTS - userState.attempts;
                if (userState.attempts >= MAX_ATTEMPTS) {
                    await client.sendMessage(
                        msg.from,
                        '❌ *Número de tentativas excedido!*\nAtendimento finalizado!\n\nDigite *Oi* para iniciar.'
                    );
                    state[from] = { step: 0, attempts: 0 };
                    delete state[from]; 
                } else {
                    await client.sendMessage(
                        msg.from,
                        `❌ *Formulário Inválido!*\nVocê tem mais ${tentativasRestantes} tentativa(s).`
                    );
                }
        return;                
                
            }
            
        } else if (userState.step === 5) {
            switch (mensagem) {
                case "8":
                    await delay (3000);
                    await chat.sendStateTyping();
                    await delay (3000);
                    await client.sendMessage(msg.from, '😃 *Perfeito!*\n\nVou aguardar o envio dos arquivos que possuir.');
                    state[from] = {step: 6};
                    return;
                case "9":
                    await delay (3000);
                    await chat.sendStateTyping();
                    await delay (3000);
                    await client.sendMessage(msg.from, '😉 *Tudo bem!*\n\nVamos seguir com seu atendimento.\nTenho certeza que nossos especialistas irão encontrar a melhor maneira de construir um projeto perfeito para você!');
                    await delay (3000);
                    await chat.sendStateTyping();
                    await delay (3000);
                    await client.sendMessage(msg.from, atendente());
                    state [from] = {step:8};
                    return;
                
                    default:
                        if (userState.attempts === undefined) userState.attempts = 0;
                        userState.attempts++;
                        const tentativasRestantes = MAX_ATTEMPTS - userState.attempts;
                        if (userState.attempts >= MAX_ATTEMPTS) {
                            await client.sendMessage(
                                msg.from,
                                '❌ *Número de tentativas excedido!*\nAtendimento finalizado!\n\nDigite *Oi* para iniciar.'
                            );
                            state[from] = { step: 0, attempts: 0 };
                            delete state[from]; 
                        } else {
                            await client.sendMessage(
                                msg.from,
                                `❌ *Opção inválida!*\nVocê tem mais ${tentativasRestantes} tentativa(s).`
                            );
                        }
                            return;
            }

            
            
            } else if (userState.step === 6) {

                if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document' || msg.type === 'video') && msg.from.endsWith('@c.us')) {
                    await delay (3000);
                    await chat.sendStateTyping();
                    await delay (3000);
                    await client.sendMessage(msg.from, '😃 *Excelente!*\n\nAlém deste arquivo, você possui outro?\n\n8️⃣ - SIM\n9️⃣ - NÃO');
                    state[from] = {step: 7};
                    return;                   
                    
                    
             } else {
                if (userState.attempts === undefined) userState.attempts = 0;
                userState.attempts++;
                const tentativasRestantes = MAX_ATTEMPTS - userState.attempts;
                if (userState.attempts >= MAX_ATTEMPTS) {
                    await client.sendMessage(
                        msg.from,
                        '❌ *Número de tentativas excedido!*\nAtendimento finalizado!\n\nDigite *Oi* para iniciar.'
                    );
                    state[from] = { step: 0, attempts: 0 }; 
                    delete state[from];
                } else {
                    await client.sendMessage(
                        msg.from,
                        `❌ *Este não é um arquivo válido!*\nVocê tem mais ${tentativasRestantes} tentativa(s).`
                    );
                }
            return;
                    
                    
                }

            }else if (userState.step === 7) {
                switch (mensagem) {
                    case "8":
                        await delay (3000);
                        await chat.sendStateTyping();
                        await delay (3000);
                        await client.sendMessage(msg.from, '😃 *Perfeito!*\n\nEstou aguardando o envio.');
                        state[from] = {step: 6};
                        return;
                    case "9":
                        await delay (3000);
                        await chat.sendStateTyping();
                        await delay (3000);
                        await client.sendMessage(msg.from, '😉 *Tudo bem!*\n\nVamos seguir com seu atendimento.');
                        await delay (3000);
                        await chat.sendStateTyping();
                        await delay (3000);
                        await client.sendMessage(msg.from, atendente());
                        state [from] = {step:8};
                        return;
                    
                        default:
                            if (userState.attempts === undefined) userState.attempts = 0;
                            userState.attempts++;
                            const tentativasRestantes = MAX_ATTEMPTS - userState.attempts;
                            if (userState.attempts >= MAX_ATTEMPTS) {
                                await client.sendMessage(
                                    msg.from,
                                    '❌ *Número de tentativas excedido!*\nAtendimento finalizado!\n\nDigite *Oi* para iniciar.'
                                );
                                state[from] = { step: 0, attempts: 0 };
                                delete state[from]; 
                            } else {
                                await client.sendMessage(
                                    msg.from,
                                    `❌ *Opção inválida!*\nVocê tem mais ${tentativasRestantes} tentativa(s).`
                                );
                            }
                                    return;
                }
            }else if (userState.step === 8){
                if (saudacoes.some(ignorar => msg.body.includes(ignorar))){
                    await delay(1800000);
                    delete state[from];
                    return;
               
                }else if(!saudacoes.some(ignorando => msg.body.includes(ignorando))){
                    await delay(1800000);
                    delete state[from];
                    return;

                }
            }
            
        } 
        
        
        

        )
};

// ROTAS ==================================================

app.get('/index', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/qrcode', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'conexao.html'));
});

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    qr: isConnected ? null : qrBase64
  });
});

app.post('/restart', async (req, res) => {
  await restartClient();
  res.json({ message: 'Reiniciado com sucesso.' });
});

app.post('/logout', async (req, res) => {
  await logoutClient();
  res.json({ message: 'Logout concluído. QR code aguardando...' });
});

const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Nenhum arquivo enviado' });

  const diaSemana = req.body.diaSemana?.toLowerCase();
  const nomeBase = {
    segunda: 'diaum',
    terca: 'diadois',
    quarta: 'diatres',
    quinta: 'diaquatro',
    sexta: 'diacinco',
    sabado: 'diaseis'
  }[diaSemana] || 'desconhecido';

  const ext = path.extname(req.file.originalname);
  const nomeFinal = `${nomeBase}${ext}`;
  const caminhoFinal = path.join(assetsDir, nomeFinal);

  fs.writeFile(caminhoFinal, req.file.buffer, err => {
    if (err) return res.status(500).json({ message: 'Erro ao salvar' });
    res.json({ message: 'Arquivo salvo com sucesso', filename: nomeFinal });
  });
});

app.post('/salvar', (req, res) => {
  const { mensagemSemana, mensagem } = req.body;
  const textoFormatado = mensagem.replace(/\r?\n/g, '\\n');
  const novaLinha = `${mensagemSemana}: ${textoFormatado}`;
  const filePath = path.join(__dirname, 'data.txt');

  const ordemDias = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

  fs.readFile(filePath, 'utf8', (err, data) => {
    let linhas = data ? data.split('\n').filter(Boolean) : [];
    const mapa = {};
    for (const linha of linhas) {
      const [dia, ...resto] = linha.split(':');
      if (ordemDias.includes(dia.trim())) {
        mapa[dia.trim()] = resto.join(':').trim();
      }
    }

    mapa[mensagemSemana] = textoFormatado;
    const novoConteudo = ordemDias.filter(dia => mapa[dia]).map(d => `${d}: ${mapa[d]}`).join('\n');

    fs.writeFile(filePath, novoConteudo + '\n', err => {
      if (err) return res.status(500).send('Erro ao salvar dados');
      res.status(200).send('Dados salvos com sucesso');
    });
  });
});

app.post('/horarios', (req, res) => {
  const { horarios } = req.body;

  if (!Array.isArray(horarios) || horarios.length === 0) {
    return res.status(400).json({ message: 'Horários inválidos' });
  }

  const unicos = [...new Set(horarios.map(h => parseInt(h)).filter(h => !isNaN(h)))];
  const ordenados = unicos.sort((a, b) => a - b);

  fs.writeFileSync(path.join(__dirname, 'horarios.txt'), ordenados.join(','), 'utf-8');

  res.status(200).json({ message: 'Horários atualizados com sucesso', horarios: ordenados });
});

app.get('/horarios', (req, res) => {
  const horarios = lerHorarios();
  res.json({ horarios });
});

app.get('/grupos', (req, res) => {
  const caminho = './grupos_scan.txt';
  if (!fs.existsSync(caminho)) return res.json([]);

  const dados = fs.readFileSync(caminho, 'utf-8');
  const grupos = dados
    .split('\n')
    .filter(Boolean)
    .map(linha => {
      const [id, nome] = linha.split('|').map(x => x.trim());
      return { id, nome };
    });

  res.json(grupos);
});

// POST /grupos – salva no grupos_check.txt
app.post('/grupos', (req, res) => {
  const grupos = req.body;
  const texto = grupos.map(g => `${g.id} | ${g.nome}`).join('\n');
  fs.writeFileSync('./grupos_check.txt', texto, 'utf-8');
  res.json({ message: 'Grupos salvos com sucesso!' });
});

//meusanuncios

app.get('/gruposcheck', (req, res) => {
  const gruposPath = path.join(__dirname, 'grupos_check.txt');

  if (!fs.existsSync(gruposPath)) {
    return res.json([]); // Retorna array vazio se o arquivo não existir
  }

  const linhas = fs.readFileSync(gruposPath, 'utf-8').split('\n').filter(Boolean);
  const grupos = linhas.map(linha => {
    const [id, nome] = linha.split('|').map(p => p.trim());
    return { id, nome };
  });

  res.json(grupos);
});

//Filtrar contatos
app.post('/internos', (req, res) => {
    try {
        const { contato } = req.body;
        
        if (!contato) {
            return res.status(400).json({ 
                success: false, 
                error: 'Contato não fornecido' 
            });
        }
        
        const filePath = path.join(__dirname, 'internos.txt');
        
        // Adicionar o contato ao arquivo (uma linha por contato)
        fs.appendFileSync(filePath, contato + '\n', 'utf-8');
        
        console.log('Contato salvo:', contato);
        
        res.json({ 
            success: true, 
            message: 'Contato salvo com sucesso',
            contato: contato
        });
        
    } catch (error) {
        console.error('Erro ao salvar contato:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Erro interno do servidor' 
        });
    }
});

//meusanuncios preview

app.get('/anuncio/:dia', (req, res) => {
  const nomesDias = {
    segunda: 'diaum',
    terca: 'diadois',
    quarta: 'diatres',
    quinta: 'diaquatro',
    sexta: 'diacinco',
    sabado: 'diaseis'
  };

  const dia = req.params.dia.toLowerCase();
  const nomeImagem = nomesDias[dia];
  if (!nomeImagem) return res.status(400).json({ error: 'Dia inválido' });

  const exts = ['jpg', 'png'];
  let imagemPath = null;
  for (const ext of exts) {
    const caminho = path.join(__dirname, 'assets', `${nomeImagem}.${ext}`);
    if (fs.existsSync(caminho)) {
      imagemPath = caminho;
      break;
    }
  }

  const imagemBase64 = imagemPath
    ? `data:image/${path.extname(imagemPath).substring(1)};base64,${fs.readFileSync(imagemPath, 'base64')}`
    : '';

  // função para ler mensagens do data.txt
  const lerMensagensDataTxt = () => {
    const dataPath = path.join(__dirname, 'data.txt');
    const mapa = {};
    if (fs.existsSync(dataPath)) {
      const conteudo = fs.readFileSync(dataPath, 'utf-8');
      const linhas = conteudo.split('\n').filter(Boolean);
      for (const linha of linhas) {
        const [diaTxt, ...resto] = linha.split(':');
        if (diaTxt && resto.length) {
          mapa[diaTxt.trim()] = resto.join(':').replace(/\\n/g, '\n').trim();
        }
      }
    }
    return mapa;
  };

  const mapaMensagens = lerMensagensDataTxt();
  const texto = mapaMensagens[dia] || '';

  res.json({ texto, imagemBase64 });
});

//meusanuncios duplicar
app.post('/copiar-anuncio', (req, res) => {
  try {
    const { diaOrigem, diasDestino } = req.body;

    if (!diaOrigem || !diasDestino || !Array.isArray(diasDestino)) {
      return res.status(400).send('Parâmetros inválidos');
    }

    const nomesDias = { segunda: 'diaum', terca: 'diadois', quarta: 'diatres', quinta: 'diaquatro', sexta: 'diacinco', sabado: 'diaseis' };

    const nomeOrigem = nomesDias[diaOrigem];
    if (!nomeOrigem) return res.status(400).send('Dia de origem inválido');

    const exts = ['.jpg', '.png'];
    let imagemOrigemPath = null;
    let extensao = '';

    for (const ext of exts) {
      const caminho = path.join(__dirname, 'assets', `${nomeOrigem}${ext}`);
      if (fs.existsSync(caminho)) {
        imagemOrigemPath = caminho;
        extensao = ext;
        break;
      }
    }
    if (!imagemOrigemPath) return res.status(404).send('Imagem de origem não encontrada');

    const mensagens = lerMensagensDataTxt();

    const textoOrigem = mensagens[diaOrigem];
    if (!textoOrigem) return res.status(404).send('Mensagem de origem não encontrada');

    diasDestino.forEach(dest => {
      const nomeDestino = nomesDias[dest];
      if (!nomeDestino) return;

      const destinoPath = path.join(__dirname, 'assets', `${nomeDestino}${extensao}`);
      fs.copyFileSync(imagemOrigemPath, destinoPath);

      mensagens[dest] = textoOrigem;
    });

    const ordemDias = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    const novaData = ordemDias
      .map(dia => mensagens[dia] ? `${dia}: ${mensagens[dia].replace(/\n/g, '\\n')}` : null)
      .filter(Boolean)
      .join('\n');

    fs.writeFileSync(path.join(__dirname, 'data.txt'), novaData + '\n');

    res.send('Anúncio copiado com sucesso.');
  } catch (error) {
    console.error('Erro em /copiar-anuncio:', error);
    res.status(500).send('Erro interno no servidor');
  }
});

//apagar anuncio
app.post('/apagar-anuncio', (req, res) => {
  try {
    const { dia } = req.body;

    if (!dia) return res.status(400).send('Dia não informado.');

    const nomesDias = { segunda: 'diaum', terca: 'diadois', quarta: 'diatres', quinta: 'diaquatro', sexta: 'diacinco', sabado: 'diaseis' };
    const nomeArquivo = nomesDias[dia];

    if (!nomeArquivo) return res.status(400).send('Dia inválido.');

    // Apagar imagem do dia
    const exts = ['.jpg', '.png'];
    for (const ext of exts) {
      const caminho = path.join(__dirname, 'assets', `${nomeArquivo}${ext}`);
      if (fs.existsSync(caminho)) fs.unlinkSync(caminho);
    }

    // Apagar texto do dia
    const mensagens = lerMensagensDataTxt();
    delete mensagens[dia];

    const ordemDias = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    const novaData = ordemDias
      .map(d => mensagens[d] ? `${d}: ${mensagens[d].replace(/\n/g, '\\n')}` : null)
      .filter(Boolean)
      .join('\n');

    fs.writeFileSync(path.join(__dirname, 'data.txt'), novaData + '\n');

    res.send(`Anúncio apagado com sucesso.`);
  } catch (error) {
    console.error('Erro em /apagar-anuncio:', error);
    res.status(500).send('Erro interno no servidor');
  }
});

//apagar todos
app.post('/apagar-todos-anuncios', (req, res) => {
  try {
    const nomesDias = { segunda: 'diaum', terca: 'diadois', quarta: 'diatres', quinta: 'diaquatro', sexta: 'diacinco', sabado: 'diaseis' };

    // Apagar todas as imagens
    Object.values(nomesDias).forEach(nomeArquivo => {
      ['.jpg', '.png'].forEach(ext => {
        const caminho = path.join(__dirname, 'assets', `${nomeArquivo}${ext}`);
        if (fs.existsSync(caminho)) fs.unlinkSync(caminho);
      });
    });

    // Limpar o data.txt
    fs.writeFileSync(path.join(__dirname, 'data.txt'), '');

    res.send('Todos os anúncios foram apagados com sucesso.');
  } catch (error) {
    console.error('Erro em /apagar-todos-anuncios:', error);
    res.status(500).send('Erro interno no servidor');
  }
});



//teste
/*app.get('/testar-envio-agora', async (req, res) => {
  const dia = new Date().getDay(); // dia atual
  const hora = new Date().getHours(); // hora atual
  const nomeImagemBase = imagemMap[dia];
  const nomeMensagem = diaMap[dia];

  if (!nomeImagemBase || !nomeMensagem) {
    return res.send('❌ Dia inválido');
  }

  const mensagemMap = lerMensagensDataTxt();
  const texto = mensagemMap[nomeMensagem];
  if (!texto) return res.send('❌ Texto não encontrado no data.txt');

  const exts = ['.jpg', '.png'];
  let caminhoImagem = null;

  for (const ext of exts) {
    const tentativa = path.join(assetsDir, `${nomeImagemBase}${ext}`);
    if (fs.existsSync(tentativa)) {
      caminhoImagem = tentativa;
      break;
    }
  }

  if (!caminhoImagem) return res.send('❌ Imagem não encontrada');

  try {
    const media = MessageMedia.fromFilePath(caminhoImagem);
    const grupos = lerGruposDestinatarios();

    for (const grupoId of grupos) {
      await client.sendMessage(grupoId, media, { caption: texto });
      console.log(`✅ Mensagem de teste enviada para ${grupoId}`);
    }

    res.send('✅ Teste de envio manual concluído.');
  } catch (erro) {
    console.error('❌ Erro no envio de teste:', erro);
    res.send('❌ Erro ao enviar mensagem de teste');
  }
});
*/

// Listar contatos filtrados
app.get('/internos', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'internos.txt');
        
        // Verificar se o arquivo existe
        if (!fs.existsSync(filePath)) {
            return res.json({ 
                success: true, 
                contatos: [] 
            });
        }
        
        // Ler o arquivo e dividir por linhas
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const contatos = fileContent
            .split('\n')
            .filter(linha => linha.trim() !== '') // Remove linhas vazias
            .map((contato, index) => ({
                id: index + 1,
                numero: contato.trim()
            }));
        
        res.json({ 
            success: true, 
            contatos: contatos 
        });
        
    } catch (error) {
        console.error('Erro ao listar contatos:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Erro interno do servidor' 
        });
    }
});

// Excluir contatos selecionados
app.delete('/internos', (req, res) => {
    try {
        const { contatosParaExcluir } = req.body;
        
        if (!contatosParaExcluir || !Array.isArray(contatosParaExcluir)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Lista de contatos para excluir não fornecida' 
            });
        }
        
        const filePath = path.join(__dirname, 'internos.txt');
        
        // Verificar se o arquivo existe
        if (!fs.existsSync(filePath)) {
            return res.json({ 
                success: true, 
                message: 'Nenhum contato para excluir' 
            });
        }
        
        // Ler todos os contatos
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const todosContatos = fileContent
            .split('\n')
            .filter(linha => linha.trim() !== '')
            .map(contato => contato.trim());
        
        // Filtrar contatos que não estão na lista de exclusão
        const contatosRestantes = todosContatos.filter(contato => 
            !contatosParaExcluir.includes(contato)
        );
        
        // Reescrever o arquivo com os contatos restantes
        const novoConteudo = contatosRestantes.join('\n') + (contatosRestantes.length > 0 ? '\n' : '');
        fs.writeFileSync(filePath, novoConteudo, 'utf-8');
        
        console.log('Contatos excluídos:', contatosParaExcluir);
        console.log('Contatos restantes:', contatosRestantes.length);
        
        res.json({ 
            success: true, 
            message: `${contatosParaExcluir.length} contato(s) excluído(s) com sucesso`,
            contatosExcluidos: contatosParaExcluir.length,
            contatosRestantes: contatosRestantes.length
        });
        
    } catch (error) {
        console.error('Erro ao excluir contatos:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Erro interno do servidor' 
        });
    }
});

//cadastro
const LOGIN_FILE = 'login.txt';

// Inicializar o arquivo login.txt, se não existir
async function inicializarArquivoLogin() {
  try {
    await fsPromises.access(LOGIN_FILE);
    console.log('Arquivo login.txt encontrado');
  } catch (error) {
    await fsPromises.writeFile(LOGIN_FILE, '', 'utf8');
    console.log('Arquivo login.txt criado');
  }
}

// Função para ler usuários do arquivo
async function lerUsuarios() {
  try {
    const data = await fsPromises.readFile(LOGIN_FILE, 'utf8');
    if (!data.trim()) return [];

    return data.trim().split('\n').map(linha => {
      const [login, senha] = linha.split(':');
      return { login, senha };
    }).filter(user => user.login && user.senha);
  } catch (error) {
    console.error('Erro ao ler usuários:', error);
    return [];
  }
}

// Função para salvar um novo usuário
async function salvarUsuario(login, senha) {
  try {
    const novaLinha = `${login}:${senha}\n`;
    await fsPromises.appendFile(LOGIN_FILE, novaLinha, 'utf8');
    return true;
  } catch (error) {
    console.error('Erro ao salvar usuário:', error);
    return false;
  }
}

// Verifica se o login já existe
async function usuarioExiste(login) {
  const usuarios = await lerUsuarios();
  return usuarios.some(user => user.login === login);
}

// ROTAS DA API

// Rota para cadastrar usuário
app.post('/cadastrar', async (req, res) => {
  try {
    const { login, senha } = req.body;
    
    // Validações
    if (!login || !senha) {
      return res.status(400).json({ 
        sucesso: false, 
        mensagem: 'Login e senha são obrigatórios!' 
      });
    }
    
    if (login.length < 3) {
      return res.status(400).json({ 
        sucesso: false, 
        mensagem: 'Login deve ter pelo menos 3 caracteres!' 
      });
    }
    
    if (senha.length < 4) {
      return res.status(400).json({ 
        sucesso: false, 
        mensagem: 'Senha deve ter pelo menos 4 caracteres!' 
      });
    }
    
    // Verificar se usuário já existe
    if (await usuarioExiste(login)) {
      return res.status(409).json({ 
        sucesso: false, 
        mensagem: 'Este login já existe!' 
      });
    }
    
    // Salvar usuário
    const sucesso = await salvarUsuario(login, senha);
    
    if (sucesso) {
      console.log(`Usuário cadastrado: ${login}`);
      res.json({ 
        sucesso: true, 
        mensagem: 'Cadastro realizado com sucesso!' 
      });
    } else {
      res.status(500).json({ 
        sucesso: false, 
        mensagem: 'Erro interno do servidor' 
      });
    }
    
  } catch (error) {
    console.error('Erro no cadastro:', error);
    res.status(500).json({ 
      sucesso: false, 
      mensagem: 'Erro interno do servidor' 
    });
  }
});

// Rota para fazer login
app.post('/login', async (req, res) => {
  try {
    const { login, senha } = req.body;
    
    if (!login || !senha) {
      return res.status(400).json({ 
        sucesso: false, 
        mensagem: 'Login e senha são obrigatórios!' 
      });
    }
    
    const usuarios = await lerUsuarios();
    const usuarioEncontrado = usuarios.find(user => 
      user.login === login && user.senha === senha
    );
    
    if (usuarioEncontrado) {
      // Gerar token simples (em produção, use JWT)
      const token = 'auth_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      
      console.log(`Login realizado: ${login}`);
      res.json({ 
        sucesso: true, 
        mensagem: 'Login realizado com sucesso!',
        token: token 
      });
    } else {
      res.status(401).json({ 
        sucesso: false, 
        mensagem: 'Login ou senha incorretos' 
      });
    }
    
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ 
      sucesso: false, 
      mensagem: 'Erro interno do servidor' 
    });
  }
});

// Rota para listar usuários (apenas para debug)
app.get('/usuarios', async (req, res) => {
  try {
    const usuarios = await lerUsuarios();
    // Não retornar senhas por segurança
    const usuariosSemSenha = usuarios.map(user => ({ login: user.login }));
    res.json(usuariosSemSenha);
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

//rota para chatbotAtivo
app.post('/chatbot-toggle', (req, res) => {
  const { ativo } = req.body;
  chatbotAtivo = ativo === true || ativo === 'true';
  console.log(`🔁 Chatbot ${chatbotAtivo ? 'ativado' : 'desativado'}`);
  res.json({ sucesso: true, ativo: chatbotAtivo });
});

app.get('/chatbot-status', (req, res) => {
  res.json({ ativo: chatbotAtivo });
});


const httpsServer = https.createServer(credentials, app);
httpsServer.listen(PORT, () => {
    console.log(`Servidor rodando em https://atentus.com.br:${PORT}`);
});
