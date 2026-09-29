import { describe, expect, it } from 'vitest';

import { askingOneAtATime } from '@/electron/asking';

/**
 * The question an answer raised.
 *
 * A question about the backend is in front of the user until its answer has
 * been applied, and the answer is what raises the next one: a deployment that
 * turns out to be unreachable only once it is tried, a port that turns out to
 * be taken after all. Asked from inside the ask it came out of it is asking
 * twice at once, which is no question at all; dropped instead, it is an answer
 * the user never hears about — the app goes on as though it had decided
 * something, with nothing on screen having decided it.
 */

/** A queue that writes down everything it put in front of the user. */
const queue = (): {
  asked: string[];
  questions: ReturnType<typeof askingOneAtATime<string>>;
} => {
  const asked: string[] = [];

  return { asked, questions: askingOneAtATime<string>((q) => asked.push(q)) };
};

describe('a question in front of the user', () => {
  it('is put there when there is nothing there', () => {
    const { asked, questions } = queue();

    questions.raise('choose');

    expect(asked).toEqual(['choose']);
  });

  it('is one at a time', () => {
    const { questions } = queue();

    expect(questions.begin()).toBe(true);
    expect(questions.begin()).toBe(false);
  });

  it('is what the second question waits for', () => {
    const { asked, questions } = queue();

    questions.begin();
    questions.raise('portInUse');

    expect(asked).toEqual([]);

    questions.end();

    expect(asked).toEqual(['portInUse']);
  });

  it('is asked again once it is over', () => {
    const { questions } = queue();

    questions.begin();
    questions.end();

    expect(questions.begin()).toBe(true);
  });

  it('keeps the question raised last, when an answer raised two', () => {
    const { asked, questions } = queue();

    questions.begin();
    questions.raise('unreachable');
    questions.raise('portInUse');
    questions.end();

    expect(asked).toEqual(['portInUse']);
  });

  it('is nothing, when the answer raised none', () => {
    const { asked, questions } = queue();

    questions.begin();
    questions.end();

    expect(asked).toEqual([]);
  });
});
