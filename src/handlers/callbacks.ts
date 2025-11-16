import { Bot } from 'grammy';
import {
	activeAnalyses,
	pendingMessages,
	startAnalysis,
} from './messageAnalysis.js';

export const waitingForCustomLimit = new Map<number, boolean>();

const CALLBACK_PREFIXES = {
	CANCEL: 'cancel_',
	ANALYZE_LIMIT: 'analyze_limit_',
} as const;

function handleCancelCallback(ctx: any, chatId: number) {
	const analysis = activeAnalyses.get(chatId);
	if (analysis && !analysis.cancel) {
		analysis.cancel = true;
		analysis.controller?.abort();
		return ctx.answerCallbackQuery({ text: '⏹ Анализ остановлен.' });
	}
	return ctx.answerCallbackQuery({
		text: '⚠️ Анализ не выполняется.',
		show_alert: false,
	});
}

function parseLimitCallback(
	data: string
): { chatId: number; limitStr: string } | null {
	const match = data.match(/^analyze_limit_(\d+)_(.+)$/);
	if (!match) return null;
	return {
		chatId: Number(match[1]),
		limitStr: match[2],
	};
}

function parseLimit(limitStr: string, maxLimit: number): number | null {
	if (limitStr === 'all') return null;
	const limit = Number.parseInt(limitStr, 10);
	if (isNaN(limit) || limit < 1) return -1;
	return Math.min(limit, maxLimit);
}

export function registerCallbacks(
	bot: Bot,
	totalFilesProcessed: { value: number },
	onAnalysisComplete?: () => void
) {
	bot.on('callback_query:data', async ctx => {
		const data = ctx.callbackQuery?.data;
		if (!data) return;

		if (data.startsWith(CALLBACK_PREFIXES.CANCEL)) {
			const chatId = Number(data.split('_')[1]);
			await handleCancelCallback(ctx, chatId);
			return;
		}

		if (data.startsWith(CALLBACK_PREFIXES.ANALYZE_LIMIT)) {
			const parsed = parseLimitCallback(data);
			if (!parsed) {
				await ctx.answerCallbackQuery({
					text: '❌ Ошибка формата callback',
					show_alert: true,
				});
				return;
			}

			const { chatId, limitStr } = parsed;
			const pending = pendingMessages.get(chatId);
			if (!pending) {
				await ctx.answerCallbackQuery({
					text: '⚠️ Данные о файле не найдены. Загрузите файл заново.',
					show_alert: true,
				});
				return;
			}

			await ctx.answerCallbackQuery();

			if (limitStr === 'custom') {
				waitingForCustomLimit.set(chatId, true);
				await ctx.editMessageText(
					`✏️ Введите количество сообщений для анализа (от 1 до ${pending.messages.length}):`
				);
				return;
			}

			const limit = parseLimit(limitStr, pending.messages.length);
			if (limit === -1) {
				await ctx.reply('❌ Некорректное количество сообщений.');
				return;
			}

			pendingMessages.delete(chatId);
			await ctx.editMessageText('✅ Начинаю анализ...');
			await startAnalysis(
				ctx,
				bot,
				chatId,
				pending.messages,
				pending.fileName,
				limit,
				totalFilesProcessed.value,
				onAnalysisComplete
			);
		}
	});
}
