import { Bot } from 'grammy';
import { BOT_TOKEN } from './config.js';

const bot = new Bot(BOT_TOKEN);

bot.on('message', async ctx => {
	console.log('Сообщение получено!');
	console.log('Chat ID:', ctx.chat.id);
	console.log('Chat Title:', ctx.chat.title || '(ЛС)');
	console.log(
		'От пользователя:',
		ctx.from?.username || ctx.from?.first_name,
		ctx.from?.id
	);

	await ctx.reply(`Принял сообщение! Chat ID: ${ctx.chat.id}`);
});

bot.start();
console.log(
	'Бот запущен. Отправь любое сообщение в группу или ЛС для теста...'
);
// npx tsx src/get_group_id.ts запуск бота который проверяет id чата
