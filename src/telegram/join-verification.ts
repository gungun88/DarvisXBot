export type JoinVerifyMode = "button" | "math" | "captcha" | "emoji" | "channel";

export type JoinVerificationChoice = {
  label: string;
  value: string;
};

export type JoinVerificationChallenge = {
  answer: string;
  prompt: string;
  choices: JoinVerificationChoice[];
};

export function isJoinVerifyMode(value: unknown): value is JoinVerifyMode {
  return value === "button" || value === "math" || value === "captcha" || value === "emoji" || value === "channel";
}

export function createJoinVerificationChallenge(mode: JoinVerifyMode, requiredChannel?: string): JoinVerificationChallenge {
  if (mode === "channel") {
    const channel = requiredChannel?.trim();
    return {
      answer: "channel",
      prompt: channel
        ? `请先加入指定频道：<code>${channel}</code>，然后点击下方按钮完成验证。`
        : "请先加入指定频道，然后点击下方按钮完成验证。",
      choices: [{ label: "✅ 我已加入频道", value: "channel" }]
    };
  }

  if (mode === "math") {
    const left = randomInt(2, 9);
    const right = randomInt(1, 9);
    const answer = String(left + right);
    const values = [answer, String(left + right - 1), String(left + right + 1), String(left + right + 2)];
    return {
      answer,
      prompt: `请计算：<b>${left} + ${right} = ?</b>`,
      choices: shuffleChoices(values.map((value) => ({ label: value, value })))
    };
  }

  if (mode === "captcha") {
    const answer = String(randomInt(1000, 9999));
    const values = new Set<string>([answer]);
    while (values.size < 4) values.add(String(randomInt(1000, 9999)));
    return {
      answer,
      prompt: `请选择与数字验证码一致的选项：<code>${answer}</code>`,
      choices: shuffleChoices([...values].map((value) => ({ label: value, value })))
    };
  }

  if (mode === "emoji") {
    const emojis = ["😀", "🚀", "🍁", "🎆"];
    const targetIndex = randomInt(0, emojis.length - 1);
    const target = emojis[targetIndex] ?? "😀";
    return {
      answer: String(targetIndex),
      prompt: `请点击这个 Emoji：<b>${target}</b>`,
      choices: shuffleChoices(emojis.map((label, index) => ({ label, value: String(index) })))
    };
  }

  return {
    answer: "button",
    prompt: "请点击下方按钮完成验证。",
    choices: [{ label: "✅ 我不是机器人", value: "button" }]
  };
}

export function shuffleChoices(choices: JoinVerificationChoice[]) {
  const result = [...choices];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index);
    const current = result[index];
    result[index] = result[swapIndex]!;
    result[swapIndex] = current!;
  }
  return result;
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
