import joplin from 'api';
import { ToolbarButtonLocation } from 'api/types';


// ============================================================
// ЛОКАЛИЗАЦИЯ
// ============================================================

const translations = {
    ru: {
        moveUp: 'Вверх',
        moveDown: 'Вниз',
        moveTop: 'В начало',
        moveBottom: 'В конец',
        moveMiddle: 'В середину',

        openNote: 'Пожалуйста, откройте заметку.',
        notEnoughNotes: 'В блокноте должно быть хотя бы две заметки.',

        cannotMoveUp: 'Невозможно переместить выше.',
        cannotMoveDown: 'Невозможно переместить ниже.',
        cannotMoveTop: 'Невозможно переместить в начало.',
        cannotMoveBottom: 'Невозможно переместить в конец.',
        cannotMoveMiddle: 'Невозможно переместить в середину.',

        moveError: 'Ошибка при перемещении заметки.',
    },

    en: {
        moveUp: 'Move Up',
        moveDown: 'Move Down',
        moveTop: 'Move to Top',
        moveBottom: 'Move to Bottom',
        moveMiddle: 'Move to Middle',

        openNote: 'Please open a note.',
        notEnoughNotes: 'The notebook must contain at least two notes.',

        cannotMoveUp: 'Cannot move up.',
        cannotMoveDown: 'Cannot move down.',
        cannotMoveTop: 'Cannot move to top.',
        cannotMoveBottom: 'Cannot move to bottom.',
        cannotMoveMiddle: 'Cannot move to middle.',

        moveError: 'Error moving note.',
    },
};

type Language = 'ru' | 'en';

type TranslationKey =
    keyof typeof translations.en;

function getLanguage(locale: string): Language {
    return locale.toLowerCase().startsWith('ru')
        ? 'ru'
        : 'en';
}


// ============================================================
// ТИПЫ
// ============================================================

type MoveDirection =
    | 'up'
    | 'down'
    | 'top'
    | 'bottom'
    | 'middle';

interface NoteItem {
    id: string;
    title: string;
    order: number;

    // Положение в исходной постраничной выборке.
    sourcePage: number;
    pageIndex: number;
    globalIndex: number;
}


// ============================================================
// ТЕКУЩАЯ ЗАМЕТКА И БЛОКНОТ
// ============================================================

async function getCurrentNoteAndFolder() {

    const note =
        await joplin.workspace.selectedNote();

    if (!note) {
        return {
            noteId: null,
            folderId: null,
        };
    }

    return {
        noteId: note.id,
        folderId: note.parent_id,
    };
}


// ============================================================
// ПОЛУЧЕНИЕ ВСЕХ ЗАМЕТОК БЛОКНОТА
//
// ВАЖНО:
//
// Joplin API возвращает коллекцию постранично.
// Поэтому загружаем все страницы.
//
// После этого внутри плагина существует единый
// глобальный массив allNotes[].
//
// При order ASC:
//
//   index 0     = визуально нижняя запись
//   последний   = визуально верхняя запись
//
// Это соответствует экспериментально подтверждённой
// модели Joplin 3.6.21.
// ============================================================

async function getAllNotesInFolder(
    folderId: string
): Promise<NoteItem[]> {

    if (!folderId) {
        return [];
    }

    const allNotes: NoteItem[] = [];

    let page = 1;

    while (true) {

        const result =
            await joplin.data.get(
                ['folders', folderId, 'notes'],
                {
                    fields: [
                        'id',
                        'title',
                        'order',
                    ],

                    order_by: 'order',
                    order_dir: 'ASC',

                    page,
                    limit: 100,
                }
            );


        for (
            let pageIndex = 0;
            pageIndex < result.items.length;
            pageIndex++
        ) {

            const note =
                result.items[pageIndex];

            allNotes.push({
                id: note.id,
                title: note.title || '',
                order: note.order ?? 0,

                sourcePage: page,
                pageIndex,
                globalIndex: allNotes.length,
            });
        }


        if (!result.has_more) {
            break;
        }

        page++;
    }

    return allNotes;
}


// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ РАБОТЫ С ORDER
// ============================================================

function getMinOrder(
    notes: NoteItem[]
): number {

    return Math.min(
        ...notes.map(note => note.order)
    );
}


function getMaxOrder(
    notes: NoteItem[]
): number {

    return Math.max(
        ...notes.map(note => note.order)
    );
}


// ------------------------------------------------------------
// ORDER ДЛЯ ВСТАВКИ МЕЖДУ ДВУМЯ СОСЕДЯМИ
//
// Joplin экспериментально показал:
// newOrder = (leftOrder + rightOrder) / 2
// ------------------------------------------------------------

function getMiddleOrder(
    leftOrder: number,
    rightOrder: number
): number {

    return (
        leftOrder +
        rightOrder
    ) / 2;
}


// ------------------------------------------------------------
// ORDER ДЛЯ ВСТАВКИ В ВИЗУАЛЬНЫЙ КОНЕЦ
//
// В API ASC это самый маленький order.
//
// Эксперимент:
//
// minOrder = 52384054844.5625
//
// Joplin:
// newOrder = 26192027422.28125
//
// То есть:
//
// newOrder = minOrder / 2
// ------------------------------------------------------------

function getBottomOrder(
    remainingNotes: NoteItem[]
): number {

    const minOrder =
        getMinOrder(remainingNotes);

    return minOrder / 2;
}


// ------------------------------------------------------------
// ORDER ДЛЯ ВСТАВКИ В ВИЗУАЛЬНОЕ НАЧАЛО
//
// По нашей экспериментальной договорённости:
//
// newOrder = maxOrder + currentTimestamp / 2
//
// Важно:
//
//     maxOrder + (currentTimestamp / 2)
//
// а НЕ:
//
//     (maxOrder + currentTimestamp) / 2
//
// Это обеспечивает увеличение относительно текущего
// максимального order при положительном timestamp.
// ------------------------------------------------------------

function getTopOrder(
    remainingNotes: NoteItem[]
): number {

    const maxOrder =
        getMaxOrder(remainingNotes);

    const currentTimestamp =
        Date.now();

    return (
        maxOrder +
        currentTimestamp / 2
    );
}


// ============================================================
// ПОЛУЧЕНИЕ НОВОГО ORDER
//
// ВАЖНО:
//
// Мы НЕ меняем order других заметок.
//
// Функция вычисляет только одно число:
//
//     newOrder
//
// для перемещаемой заметки.
//
// ============================================================

function calculateNewOrder(
    notes: NoteItem[],
    currentIndex: number,
    direction: MoveDirection
): number | null {

    const count =
        notes.length;

    if (
        currentIndex < 0 ||
        currentIndex >= count
    ) {
        return null;
    }


    const currentNote =
        notes[currentIndex];


    // --------------------------------------------------------
    // Формируем список БЕЗ текущей заметки.
    //
    // Это принципиально важно для вычисления соседей.
    // --------------------------------------------------------

    const remainingNotes =
        notes.filter(
            note =>
                note.id !== currentNote.id
        );


    if (remainingNotes.length === 0) {
        return null;
    }


    // ========================================================
    // ВВЕРХ
    //
    // Визуально вверх = увеличение API index.
    //
    // Например API:
    //
    // A B C D
    //         ↑
    // визуально:
    //
    // D
    // C  ← current
    // B
    // A
    //
    // После "Вверх":
    //
    // D
    // C
    // B
    // A
    //
    // Текущая C должна попасть между D и B.
    //
    // После удаления текущей заметки соответствующая
    // позиция определяется через remainingNotes.
    // ========================================================

    if (direction === 'up') {

        const targetIndexOriginal =
            currentIndex + 1;


        if (
            targetIndexOriginal >= count
        ) {
            return null;
        }


        // После удаления текущей записи
        // targetIndexOriginal может уменьшиться на 1.
        const targetIndexRemaining =
            currentIndex < targetIndexOriginal
                ? targetIndexOriginal - 1
                : targetIndexOriginal;


        const leftNote =
            remainingNotes[targetIndexRemaining];


        const rightNote =
            remainingNotes[targetIndexRemaining + 1];


        // Если справа есть запись,
        // вставляемся между ними.
        if (rightNote) {

            return getMiddleOrder(
                leftNote.order,
                rightNote.order
            );
        }


        // Если справа больше ничего нет,
        // мы фактически вставляемся в визуальное начало.
        return getTopOrder(
            remainingNotes
        );
    }


    // ========================================================
    // ВНИЗ
    //
    // Визуально вниз = уменьшение API index.
    // ========================================================

    if (direction === 'down') {

        const targetIndexOriginal =
            currentIndex - 1;


        if (
            targetIndexOriginal < 0
        ) {
            return null;
        }


        const targetIndexRemaining =
            currentIndex < targetIndexOriginal
                ? targetIndexOriginal - 1
                : targetIndexOriginal;


        const leftNote =
            remainingNotes[
                targetIndexRemaining - 1
            ];

        const rightNote =
            remainingNotes[
                targetIndexRemaining
            ];


        // Внутренняя позиция.
        if (
            leftNote &&
            rightNote
        ) {

            return getMiddleOrder(
                leftNote.order,
                rightNote.order
            );
        }


        // Если вставляемся в нижнюю границу.
        if (rightNote) {

            return getBottomOrder(
                remainingNotes
            );
        }


        return null;
    }


    // ========================================================
    // В НАЧАЛО
    //
    // Визуальное начало = самая верхняя позиция.
    // В API это конец массива.
    // ========================================================

    if (direction === 'top') {

        // Если текущая заметка уже самая верхняя,
        // вызывающий код должен был это перехватить.
        if (
            currentIndex === count - 1
        ) {
            return null;
        }

        return getTopOrder(
            remainingNotes
        );
    }


    // ========================================================
    // В КОНЕЦ
    //
    // Визуальный конец = самая нижняя позиция.
    // В API это index 0.
    // ========================================================

    if (direction === 'bottom') {

        if (
            currentIndex === 0
        ) {
            return null;
        }

        return getBottomOrder(
            remainingNotes
        );
    }


    // ========================================================
    // В СЕРЕДИНУ
    //
    // Сначала определяем среднюю визуальную позицию.
    //
    // Затем переводим её в API index.
    // ========================================================

    if (direction === 'middle') {

        const visualMiddleIndex =
            Math.floor(count / 2);


        // Перевод визуального индекса
        // в API-индекс.
        const targetIndexOriginal =
            count -
            1 -
            visualMiddleIndex;


        // Если текущая запись уже находится там,
        // ничего делать не нужно.
        if (
            currentIndex ===
            targetIndexOriginal
        ) {
            return null;
        }


        // После удаления текущей записи
        // индекс целевой позиции может уменьшиться.
        const targetIndexRemaining =
            currentIndex < targetIndexOriginal
                ? targetIndexOriginal - 1
                : targetIndexOriginal;


        const leftNote =
            remainingNotes[
                targetIndexRemaining - 1
            ];

        const rightNote =
            remainingNotes[
                targetIndexRemaining
            ];


        if (
            leftNote &&
            rightNote
        ) {

            return getMiddleOrder(
                leftNote.order,
                rightNote.order
            );
        }


        // Теоретически для середины сюда
        // попадать не должны, но оставляем
        // безопасную обработку границ.

        if (rightNote) {

            return getBottomOrder(
                remainingNotes
            );
        }


        if (leftNote) {

            return getTopOrder(
                remainingNotes
            );
        }

        return null;
    }


    return null;
}


// ============================================================
// ПОПЫТКА УЛОВИТЬ СИТУАЦИЮ С ОЧЕНЬ МАЛЕНЬКИМ ИНТЕРВАЛОМ
//
// Пока мы не перенумеровываем соседей.
//
// Однако если среднее математически совпало
// с одним из соседних order из-за потери точности,
// возвращаем null.
// ============================================================

function isValidNewOrder(
    newOrder: number,
    notes: NoteItem[],
    currentNoteId: string
): boolean {

    if (
        !Number.isFinite(newOrder)
    ) {
        return false;
    }


    const EPSILON =
        Number.EPSILON *
        Math.max(
            1,
            Math.abs(newOrder)
        );


    for (const note of notes) {

        if (
            note.id === currentNoteId
        ) {
            continue;
        }


        if (
            Math.abs(
                note.order - newOrder
            ) <= EPSILON
        ) {

            return false;
        }
    }


    return true;
}


// ============================================================
// ЛОКАЛИЗОВАННОЕ СООБЩЕНИЕ О НЕВОЗМОЖНОМ ПЕРЕМЕЩЕНИИ
// ============================================================

function getCannotMoveMessageKey(
    notes: NoteItem[],
    currentIndex: number,
    direction: MoveDirection
): TranslationKey | null {

    const lastIndex =
        notes.length - 1;


    if (
        direction === 'up' &&
        currentIndex === lastIndex
    ) {
        return 'cannotMoveUp';
    }


    if (
        direction === 'down' &&
        currentIndex === 0
    ) {
        return 'cannotMoveDown';
    }


    if (
        direction === 'top' &&
        currentIndex === lastIndex
    ) {
        return 'cannotMoveTop';
    }


    if (
        direction === 'bottom' &&
        currentIndex === 0
    ) {
        return 'cannotMoveBottom';
    }


    if (
        direction === 'middle'
    ) {

        const visualCurrentIndex =
            lastIndex -
            currentIndex;


        const visualMiddleIndex =
            Math.floor(
                notes.length / 2
            );


        if (
            visualCurrentIndex ===
            visualMiddleIndex
        ) {
            return 'cannotMoveMiddle';
        }
    }


    return null;
}


// ============================================================
// ПЕРЕМЕЩЕНИЕ ЗАМЕТКИ
//
// НОВАЯ АРХИТЕКТУРА:
//
//     GET all pages
//          ↓
//     найти текущую
//          ↓
//     вычислить новый order
//          ↓
//     ОДИН PUT
//
// Никаких swap.
// Никакой массовой перенумерации.
// Никакого Promise.all.
// ============================================================

async function moveNote(
    direction: MoveDirection,
    t: (key: TranslationKey) => string
) {

    // --------------------------------------------------------
    // Получаем текущую заметку и блокнот.
    // --------------------------------------------------------

    const {
        noteId,
        folderId,
    } =
        await getCurrentNoteAndFolder();


    if (
        !noteId ||
        !folderId
    ) {

        await joplin.views.dialogs.showMessageBox(
            t('openNote')
        );

        return;
    }


    // --------------------------------------------------------
    // Загружаем весь блокнот.
    // --------------------------------------------------------

    const notes =
        await getAllNotesInFolder(
            folderId
        );


    if (
        notes.length < 2
    ) {

        await joplin.views.dialogs.showMessageBox(
            t('notEnoughNotes')
        );

        return;
    }


    // --------------------------------------------------------
    // Находим текущую запись
    // в глобальном массиве.
    // --------------------------------------------------------

    const currentIndex =
        notes.findIndex(
            note =>
                note.id === noteId
        );


    if (
        currentIndex === -1
    ) {
        return;
    }


    // --------------------------------------------------------
    // Проверяем границы.
    // --------------------------------------------------------

    const cannotMove =
        getCannotMoveMessageKey(
            notes,
            currentIndex,
            direction
        );


    if (cannotMove) {

        await joplin.views.dialogs.showMessageBox(
            t(cannotMove)
        );

        return;
    }


    // --------------------------------------------------------
    // Вычисляем ОДИН новый order.
    // --------------------------------------------------------

    const newOrder =
        calculateNewOrder(
            notes,
            currentIndex,
            direction
        );


    if (
        newOrder === null
    ) {

        const fallbackMessage =
            direction === 'up'
                ? 'cannotMoveUp'
                : direction === 'down'
                    ? 'cannotMoveDown'
                    : direction === 'top'
                        ? 'cannotMoveTop'
                        : direction === 'bottom'
                            ? 'cannotMoveBottom'
                            : 'cannotMoveMiddle';


        await joplin.views.dialogs.showMessageBox(
            t(fallbackMessage)
        );

        return;
    }


    // --------------------------------------------------------
    // Проверяем, что новый order:
    //
    // 1. является конечным числом;
    // 2. не совпадает с order другой заметки.
    // --------------------------------------------------------

    if (
        !isValidNewOrder(
            newOrder,
            notes,
            noteId
        )
    ) {

        console.error(
            'Move Note plugin: ' +
            'calculated order is invalid.',
            {
                direction,
                currentIndex,
                newOrder,
            }
        );


        await joplin.views.dialogs.showMessageBox(
            t('moveError')
        );

        return;
    }


    // --------------------------------------------------------
    // ОДИН PUT.
    //
    // Только текущая заметка получает новый order.
    // --------------------------------------------------------

    try {

        await joplin.data.put(
            ['notes', noteId],
            null,
            {
                order: newOrder,
            }
        );


        console.info(
            'Move Note plugin: ' +
            'single-PUT move completed.',
            {
                direction,
                noteId,
                oldOrder:
                    notes[currentIndex].order,
                newOrder,
                totalNotes:
                    notes.length,
            }
        );

    } catch (error) {

        console.error(
            'Move Note plugin: ' +
            'error moving note:',
            error
        );


        await joplin.views.dialogs.showMessageBox(
            t('moveError')
        );
    }
}


// ============================================================
// ЗАПУСК ПЛАГИНА
// ============================================================

joplin.plugins.register({

    onStart: async function () {

        // ----------------------------------------------------
        // Определяем язык интерфейса.
        // ----------------------------------------------------

        let locale = 'en_US';


        try {

            locale =
                await joplin.settings.globalValue(
                    'locale'
                );

        } catch (error) {

            console.warn(
                'Move Note plugin: ' +
                'unable to determine locale. ' +
                'Using English.'
            );
        }


        const language =
            getLanguage(locale);


        const t =
            (
                key: TranslationKey
            ): string =>
                translations[language][key];


        // ----------------------------------------------------
        // Команды.
        // ----------------------------------------------------

        const actions: Array<{
            name: string;
            label: string;
            dir: MoveDirection;
            icon: string;
        }> = [

            {
                name: 'moveNoteUp',
                label: t('moveUp'),
                dir: 'up',
                icon: 'fas fa-arrow-up',
            },

            {
                name: 'moveNoteDown',
                label: t('moveDown'),
                dir: 'down',
                icon: 'fas fa-arrow-down',
            },

            {
                name: 'moveNoteTop',
                label: t('moveTop'),
                dir: 'top',
                icon: 'fas fa-angle-double-up',
            },

            {
                name: 'moveNoteBottom',
                label: t('moveBottom'),
                dir: 'bottom',
                icon: 'fas fa-angle-double-down',
            },

            {
                name: 'moveNoteMiddle',
                label: t('moveMiddle'),
                dir: 'middle',
                icon: 'fas fa-arrows-alt-v',
            },
        ];


        // ----------------------------------------------------
        // Регистрируем команды.
        // ----------------------------------------------------

        for (
            const action of actions
        ) {

            await joplin.commands.register({

                name:
                    action.name,

                label:
                    action.label,

                iconName:
                    action.icon,

                execute:
                    async () => {

                        await moveNote(
                            action.dir,
                            t
                        );

                    },
            });
        }


        // ----------------------------------------------------
        // Меню текущей заметки.
        //
        // На mobile:
        // ToolbarButtonLocation.NoteToolbar
        //
        // отображается в меню действий заметки.
        // ----------------------------------------------------

        for (
            const action of actions
        ) {

            await joplin.views.toolbarButtons.create(
                `${action.name}Button`,
                action.name,
                ToolbarButtonLocation.NoteToolbar
            );
        }
    },
});