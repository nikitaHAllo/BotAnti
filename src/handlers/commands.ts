import { Bot } from 'grammy';
import { ADMINS } from '../config.js';
import { checkBotPermissions } from './violationHandler.js';
import { createLimitKeyboard, pendingMessages } from './messageAnalysis.js';
import { MessageData } from './documentHandler.js';

let isCheckingChat = false;

export function getIsCheckingChat(): boolean {
	return isCheckingChat;
}

export function setIsCheckingChat(value: boolean): void {
	isCheckingChat = value;
}

function isAdmin(ctx: any): boolean {
	return ctx.from && ADMINS.includes(ctx.from.id);
}

export function registerCommands(
	bot: Bot,
	allMessages: MessageData[],
	totalFilesProcessed: { value: number }
) {
	bot.command('check_chat', async ctx => {
		if (!isAdmin(ctx)) return ctx.reply('❌ У тебя нет доступа к этой команде');
		isCheckingChat = true;
		await ctx.reply(
			'✅ Бот готов анализировать все сообщения, которые ты пришлёшь в ЛС.'
		);
	});

	bot.command('stop_check_chat', async ctx => {
		if (!isAdmin(ctx)) return ctx.reply('❌ У тебя нет доступа к этой команде');
		isCheckingChat = false;
		await ctx.reply('🛑 Режим анализа отключён.');
	});

	bot.command('check_permissions', async ctx => {
		if (!isAdmin(ctx)) return ctx.reply('❌ У тебя нет доступа к этой команде');
		if (ctx.chat.type === 'private')
			return ctx.reply('ℹ️ Эта команда работает только в группах и каналах');

		const hasPermissions = await checkBotPermissions(bot, ctx.chat.id);
		if (hasPermissions)
			await ctx.reply('✅ Бот имеет необходимые права администратора');
		else
			await ctx.reply(
				'❌ Бот не имеет прав администратора или прав недостаточно. Требуются права на удаление сообщений.'
			);
	});

	bot.command('analyze', async ctx => {
		if (allMessages.length === 0) {
			await ctx.reply('📭 Нет сообщений для анализа. Сначала загрузите файлы.');
			return;
		}

		const chatId = ctx.chat.id;
		const limitKeyboard = createLimitKeyboard(chatId);

		await ctx.reply(
			`📊 Готов к анализу!\n` +
				`📁 Обработано файлов: ${totalFilesProcessed.value}\n` +
				`📨 Всего сообщений: ${allMessages.length}\n\n` +
				`Выберите, сколько сообщений анализировать:`,
			{
				reply_markup: limitKeyboard,
			}
		);

		pendingMessages.set(chatId, {
			messages: allMessages,
			fileName: `все_файлы_(${totalFilesProcessed.value})`,
		});
	});
}
