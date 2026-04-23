const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

const AUTH_FOLDER = '/data/baileys/auth';

const GRUPO_TIC_JID = process.env.BAILEYS_GROUP_JID || '';

let sock = null;
let conectado = false;
let colaEnvio = [];

async function iniciarBaileys() {
  if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  console.log('🟡 [Baileys] Iniciando — versión WA:', version);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', '', ''],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 [Baileys] QR recibido — generando enlace para escanear...');
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
      console.log('🔗 [Baileys] Abrí este enlace en el navegador para ver el QR:');
      console.log(qrUrl);
    }

    if (connection === 'open') {
      conectado = true;
      console.log('✅ [Baileys] Conectado a WhatsApp');

      if (!GRUPO_TIC_JID) {
        await listarGrupos();
      }

      if (colaEnvio.length > 0) {
        console.log(`📤 [Baileys] Enviando ${colaEnvio.length} mensajes en cola...`);
        for (const texto of colaEnvio) {
          await _enviarTexto(texto);
        }
        colaEnvio = [];
      }
    }

    if (connection === 'close') {
      conectado = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const debeReconectar = statusCode !== DisconnectReason.loggedOut;

      console.warn(`⚠️ [Baileys] Conexión cerrada. Código: ${statusCode}`);

      if (debeReconectar) {
        console.log('🔄 [Baileys] Reconectando en 5 segundos...');
        setTimeout(iniciarBaileys, 5000);
      } else {
        console.error('🚫 [Baileys] Sesión cerrada. Borrá /data/baileys/auth y volvé a escanear el QR.');
      }
    }
  });
}

async function listarGrupos() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    console.log('📋 [Baileys] Grupos disponibles:');
    for (const [jid, info] of Object.entries(groups)) {
      console.log(`   - "${info.subject}" → JID: ${jid}`);
    }
    console.log('👉 Copiá el JID y ponelo en la variable BAILEYS_GROUP_JID en Render');
  } catch (e) {
    console.error('❌ [Baileys] Error listando grupos:', e.message);
  }
}

async function _enviarTexto(texto) {
  if (!GRUPO_TIC_JID) {
    console.error('❌ [Baileys] BAILEYS_GROUP_JID no definido en variables de entorno');
    return false;
  }
  try {
    await sock.sendMessage(GRUPO_TIC_JID, { text: texto });
    console.log('✅ [Baileys] Mensaje enviado al grupo TIC');
    return true;
  } catch (e) {
    console.error('❌ [Baileys] Error enviando al grupo:', e.message);
    return false;
  }
}

async function enviarAlGrupoTIC(datos, idReclamo) {
  const serviciosNormalizados = ['internet', 'television', 'telefonia'];
  const servicioNorm = (datos.servicio || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!serviciosNormalizados.includes(servicioNorm)) return;

  const texto =
    `🚨 *NUEVO RECLAMO TIC — ID ${idReclamo}*\n` +
    `──────────────────────\n` +
    `📡 *Servicio:*    ${(datos.servicio || '').toUpperCase()}\n` +
    `🔢 *Suministro:* ${datos.suministro || '—'}\n` +
    `👤 *Titular:*     ${datos.nombre || '—'}\n` +
    `📍 *Dirección:*  ${datos.direccion || '—'}\n` +
    `📞 *Teléfono:*   ${datos.telefono || '—'}\n` +
    `💬 *Detalle:*    ${datos.mensaje || datos.descripcion || '—'}\n` +
    `📌 *GPS:*        ${datos.gps || 'No compartido'}\n` +
    `──────────────────────`;

  if (!conectado || !sock) {
    console.warn('⚠️ [Baileys] No conectado — mensaje en cola');
    colaEnvio.push(texto);
    return;
  }

  await _enviarTexto(texto);
}

module.exports = { iniciarBaileys, enviarAlGrupoTIC };
