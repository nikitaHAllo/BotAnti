import { Bot, Context } from 'grammy';
import { LOG_CHAT_ID } from '../config.js';
import { DELETE_MESSAGES } from '../state.js';
import { dbPromise } from '../db.js';

const VIOLATION_REASONS: Record<string, string> = {
	violation_profanity: 'ненормативная лексика',
	violation_ad: 'реклама',
	violation_custom: 'запрещенные слова',
	neural_bad_words: 'нежелательный контент (нейросеть)',
	neural_cars: 'автомобильная тема (нейросеть)',
	neural_advertising: 'реклама (нейросеть)',
};

export function getViolationReason(type: string | null): string {
	if (!type) return 'нарушение правил';
	return VIOLATION_REASONS[type] || 'нарушение правил';
}

export async function checkBotPermissions(
	bot: Bot,
	chatId: number
): Promise<boolean> {
	try {
		const chatMember = await bot.api.getChatMember(
			chatId,
			(
				await bot.api.getMe()
			).id
		);
		if (chatMember.status === 'administrator') {
			const permissions = (chatMember as any).can_delete_messages;
			return permissions === true;
		}
		return false;
	} catch (error) {
		console.log('Бот не админ в чате:', chatId);
		return false;
	}
}

async function logViolation(
	bot: Bot,
	chatId: number,
	userId: number,
	violationType: string,
	text: string,
	messageId: number,
	chatTitle: string | undefined,
	userName: string
) {
	if (!LOG_CHAT_ID) return;

	try {
		await bot.api.sendMessage(
			LOG_CHAT_ID,
			`🚨 Нарушение!\n📌 Чат: ${chatId} (${
				chatTitle || 'ЛС'
			})\n👤 Пользователь: ${userName} (${userId})\nТип нарушения: ${violationType}\nТекст: ${text}`
		);
		await bot.api.forwardMessage(LOG_CHAT_ID, chatId, messageId);
	} catch (err) {
		console.error('Ошибка при логировании нарушения:', err);
	}
}

async function deleteViolationMessage(
	bot: Bot,
	ctx: Context,
	chatId: number,
	messageId: number,
	violationType: string
) {
	const warning = await ctx.reply(
		`⚠️ Сообщение от @${
			ctx.from!.username || ctx.from!.first_name
		} удалено.\nПричина: ${getViolationReason(violationType)}`
	);
	await bot.api.deleteMessage(chatId, messageId);
	setTimeout(async () => {
		try {
			await bot.api.deleteMessage(chatId, warning.message_id);
		} catch {}
	}, 10000);
}

export async function handleViolation(
	ctx: Context,
	bot: Bot,
	violationType: string
) {
	if (!ctx.chat || !ctx.message || !ctx.from) {
		console.error('handleViolation: required context fields are undefined');
		return;
	}

	const chatId = ctx.chat.id;
	const messageId = ctx.message.message_id;
	const userId = ctx.from.id;
	const text = ctx.message.text || ctx.message.caption || '';

	const db = await dbPromise;
	await db.run('INSERT INTO statistics (type,timestamp) VALUES (?,?)', [
		violationType,
		Math.floor(Date.now() / 1000),
	]);

	const userName = ctx.from.username
		? `@${ctx.from.username}`
		: ctx.from.first_name || `ID: ${userId}`;

	await logViolation(
		bot,
		chatId,
		userId,
		violationType,
		text,
		messageId,
		ctx.chat.title,
		userName
	);

	try {
		const isAdmin = await checkBotPermissions(bot, chatId);

		if (isAdmin && ctx.chat.type !== 'private') {
			if (DELETE_MESSAGES) {
				await deleteViolationMessage(
					bot,
					ctx,
					chatId,
					messageId,
					violationType
				);
			} else {
				console.log(
					`🚫 Нарушение у @${
						ctx.from.username || ctx.from.first_name
					}, но автоудаление отключено (${getViolationReason(violationType)})`
				);
			}
		} else if (ctx.chat.type === 'private') {
			await ctx.reply(
				`❌ Ваше сообщение содержит запрещённый контент. Причина: ${getViolationReason(
					violationType
				)}`
			);
		}
	} catch (error) {
		console.error('Ошибка при обработке нарушения:', error);
	}
}
