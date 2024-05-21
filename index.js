///////////////////SETUP//////////////////////
// Import necessary modules
const { Client, LocalAuth, MessageMedia, ContactId } = require('whatsapp-web.js');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const OpenAI = require("openai");
require('dotenv').config();

// Path where the session data will be stored
const SESSION_FILE_PATH = './session.json';

// Load the session data if it has been previously saved
let sessionData;
if(fs.existsSync(SESSION_FILE_PATH)) {
    sessionData = require(SESSION_FILE_PATH);
}

// Use the saved values
const client = new Client({
    webVersion: '2.2409.2',
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2409.2.html'
    },
    session: sessionData,
    puppeteer: {
      headless: true,
      args: ['--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],},
    authStrategy: new LocalAuth(),
});

// Create a new OpenAI API client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Show QR code for authentication
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

// Initialize client
client.initialize();

// Confirm client is ready
client.on('ready', () => {
    console.log('Client is ready!');
});

// Reconnect on disconnection
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

function reconnectClient() {
    if (reconnectAttempts < maxReconnectAttempts) {
        console.log('Attempting to reconnect...');
        client.initialize();
        reconnectAttempts++;
    } else {
        console.log(`Failed to reconnect after ${maxReconnectAttempts} attempts. Exiting...`);
        process.exit(1);
    }
}

client.on('disconnected', (reason) => {
    console.log('Client disconnected: ' + reason);
    reconnectClient();
});

// Event triggered when the client is ready
client.on('ready', async () => {
    await client.sendPresenceAvailable();
});

///////////////////SCRIPT/////////////////////////
client.on('message', async message => {
    try {
        const chat = await message.getChat();
        const messageBody = message.body.trim();
        const contact = await message.getContact();
        const contactName = contact.pushname || contact.name || contact.number;
        console.log(contactName, ':', messageBody);

        /////////////////////Summarize Messages////////////////
        if (messageBody.startsWith('#resumo')) {
            await chat.sendStateTyping();

            const parts = messageBody.split(' ');
            let limit = 0;
            if (parts.length > 1) {
                limit = parseInt(parts[1]);
            }

            if (isNaN(limit) || limit <= 0) {
                // Summarize messages from the last 3 hours
                const messages = await chat.fetchMessages({ limit: 500 });
                const lastMessage = messages[messages.length - 2];
                const lastMessageTimestamp = lastMessage.timestamp;
                const threeHoursBeforeLastMessageTimestamp = lastMessageTimestamp - 10800;
                const messagesSinceLastThreeHours = messages.slice(0, -1).filter(message => (
                    message.timestamp > threeHoursBeforeLastMessageTimestamp &&
                    message.fromMe === false &&
                    message.body.trim() !== ''
                ));
                const messageTexts = (await Promise.all(messagesSinceLastThreeHours.map(async message => {
                    const contact = await message.getContact();
                    const name = contact.pushname || contact.name || contact.number;
                    return `>>${name}: ${message.body}.\n`;
                }))).join(' ');

                console.log('\n---------------------RESUMO DE MENSAGENS---------------------\nMENSSAGENS:\n', messageTexts);
                runCompletion(messageTexts)
                    .then(result => result.trim())
                    .then(result => message.reply(result) + console.log('\nBOT: ' + result + '\n---------------------FIM---------------------\n'));
            } else {
                // Summarize the specified number of messages
                const messages = await chat.fetchMessages({ limit: limit + 1 });
                const messagesWithoutMe = messages.slice(0, -1).filter(message => (
                    message.fromMe === false &&
                    message.body.trim() !== ''
                ));
                const messageTexts = (await Promise.all(messagesWithoutMe.map(async message => {
                    const contact = await message.getContact();
                    const name = contact.pushname || contact.name || contact.number;
                    return `>>${name}: ${message.body}.\n`;
                }))).join(' ');

                console.log('\n---------------------RESUMO DE MENSAGENS #---------------------\nMENSSAGENS:\n', messageTexts);
                runCompletion(messageTexts)
                    .then(result => result.trim())
                    .then(result => message.reply(result) + console.log('\nBOT: ' + result + '\n---------------------FIM---------------------\n'));
            }
        }
    } catch (error) {
        console.error('An error occurred while processing a message:', error);
    }
});

/////////////////////FUNCTIONS/////////////////////////
async function runCompletion(messageTexts) {
    try {
        // Bot function
        const botRole = "Você é um bot assistente pessoal em um grupo de WhatsApp, o qual está coordenando ajuda e suprimentos para uma região afetada por um desastre natural. Sua função é resumir as mensagens, enquanto mantém informações relevantes ao grupo.\n1. Se houver pessoas doando algo, faça uma lista de doações nesse formato:\n\"DOAÇÃO: Item – Quantidade – Local – Nome do Usuário ou Número de telefone\"\n2. Se houver pessoas pedindo doações, faça uma lista de doações nesse formato:\n\"PEDIDOS: Item – Quantidade – Local – Nome do Usuário ou Número de telefone\"\n3. Se Não houver informação relevante para resumir ou falta de informação apenas informe o usuário em uma simples frase.\n";

        // Add the bot's role to the user's prompt
        const completePrompt = botRole + messageTexts;

        const completion = await openai.chat.completions.create({
            messages: [{ "role": "system", "content": "You are a WhatsApp group assistant." },
            { "role": "user", "content": completePrompt }],
            model: "gpt-4",
        });
        console.log(completePrompt);
        return completion.choices[0].message.content;
    } catch (error) {
        console.error('An error occurred in the runCompletion function:', error);
        return ''; // Return an empty string or other appropriate value in case of an error
    }
}
