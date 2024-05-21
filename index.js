///////////////////SETUP//////////////////////
// Import necessary modules
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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
  apiKey: process.env.OPENAI_API_KEY // This is also the default, can be omitted
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
  // Set the bot's state as "online"
  await client.sendPresenceAvailable();
});

///////////////////SCRIPT/////////////////////////
client.on('message', async message => {
    try {
        const chat = await message.getChat();

        // Check if the chat is a group and has more than 100 members
        if (chat.isGroup) {
            const participants = await chat.participants;
            if (participants.length <= 100) {
                console.log('Group has 100 or fewer members. Skipping message processing.');
                return; // Exit if there are 100 or fewer members
            }
        } else {
            console.log('This is not a group chat. Skipping message processing.');
            return; // Exit if it's not a group chat
        }

        const messageBody = message.body.trim();
        const contactName = (await message.getContact()).name;
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
                // Summarize messages from the last hour
                const messages = await chat.fetchMessages({ limit: 500 });
                const lastMessage = messages[messages.length - 2];
                const lastMessageTimestamp = lastMessage.timestamp;
                const oneHourBeforeLastMessageTimestamp = lastMessageTimestamp - 3600;
                const messagesSinceLastHour = messages.slice(0, -1).filter(message => (
                    message.timestamp > oneHourBeforeLastMessageTimestamp &&
                    message.fromMe === false &&
                    message.body.trim() !== ''
                ));
                const messageTexts = (await Promise.all(messagesSinceLastHour.map(async message => {
                    const contact = await message.getContact();
                    const name = contact.name || 'Unknown';
                    return `>>${name}: ${message.body}.\n`;
                }))).join(' ');

                console.log('\n---------------------RESUMO DE MENSAGENS---------------------\nMENSSAGENS:\n', messageTexts);
                const contact = await message.getContact();
                const name = contact.name || 'Unknown';
                let prompt = `${name} está pedindo para que você faça um resumo das mensagens dessa conversa do grupo e diga no início da sua resposta que esse é o resumo das mensagens na última hora:\n${messageTexts}`;
                runCompletion(prompt)
                    .then(result => result.trim())
                    .then(result => message.reply(result) + console.log('\nBOT: ' + result + '\n---------------------FIM---------------------\n'))
                    .then(sentMessage => {
                        // Delete the bot's message after 5 minutes
                        setTimeout(() => {
                            sentMessage.delete(true);
                        }, 5 * 60 * 1000);
                    });
            } else {
                // Summarize the specified number of messages
                const messages = await chat.fetchMessages({ limit: limit + 1 });
                const messageswithoutme = messages.slice(0, -1).filter(message => (
                    message.fromMe === false &&
                    message.body.trim() !== ''
                ));
                const messageTexts = (await Promise.all(messageswithoutme.map(async message => {
                    const contact = await message.getContact();
                    const name = contact.name || 'Unknown';
                    return `>>${name}: ${message.body}.\n`;
                }))).join(' ');

                console.log('\n---------------------RESUMO DE MENSAGENS #---------------------\nMENSSAGENS:\n', messageTexts);
                const contact = await message.getContact();
                const name = contact.name || 'Unknown';
                let prompt = `${name} está pedindo para que você faça um resumo dessas últimas mensagens dessa conversa do grupo:\n${messageTexts}`;
                runCompletion(prompt)
                    .then(result => result.trim())
                    .then(result => message.reply(result) + console.log('\nBOT: ' + result + '\n---------------------FIM---------------------\n'))
                    .then(sentMessage => {
                        // Delete the bot's message after 5 minutes
                        setTimeout(() => {
                            sentMessage.delete(true);
                        }, 5 * 60 * 1000);
                    });
            }
        }
    } catch (error) {
        console.error('An error occurred while processing a message:', error);
        // Handle the error or log it, but don't stop the client
    }
});

/////////////////////FUNCTIONS/////////////////////////
async function runCompletion(prompt) {
    try {
        // Bot function
        const botRole = "Você é um bot assistente pessoal em um grupo de WhatsApp, o qual está coordenando ajuda e suprimentos para uma região afetada por um disastre natural. Sua função resumir as mensagens, em quanto mantendo informações relevante ao grupo.\n\n";

        // Add the bot's role to the user's prompt
        const completePrompt = botRole + prompt;

        const completion = await openai.chat.completions.create({
            messages: [{ "role": "system", "content": "You are a WhatsApp group assistant." },
            { "role": "user", "content": completePrompt }],
            model: "gpt-4",
        });
        console.log(completePrompt);
        return completion.choices[0].message.content;
    } catch (error) {
        console.error('An error occurred in the runCompletion function:', error);
        // Handle the error or log it
        return ''; // Return an empty string or other appropriate value in case of an error
    }
}
