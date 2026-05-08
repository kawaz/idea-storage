import { describe, expect, test } from "bun:test";
import { redactSecrets } from "./redact.ts";

describe("redactSecrets", () => {
  describe("AWS access key", () => {
    test("AKIA で始まる 20 文字のキーを検出する", () => {
      const text = "my key is AKIAIOSFODNN7EXAMPLE here";
      const result = redactSecrets(text);
      expect(result.text).toBe("my key is [REDACTED:AWS_ACCESS_KEY] here");
      expect(result.count).toBe(1);
    });

    test("AKIA に続く文字数が足りない場合は検出しない", () => {
      const text = "AKIASHORT";
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });

    test("AKIA を含むが小文字混じりの似た文字列は検出しない", () => {
      const text = "AKIAabcdefghijklmnop";
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });
  });

  describe("AWS secret access key", () => {
    test("aws_secret_access_key= 形式を検出する", () => {
      const text = "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const result = redactSecrets(text);
      expect(result.text).toBe("aws_secret_access_key=[REDACTED]");
      expect(result.count).toBe(1);
    });

    test("aws_secret_access_key : 形式（コロン + スペース）を検出する", () => {
      const text = "aws_secret_access_key : wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const result = redactSecrets(text);
      expect(result.text).toContain("aws_secret_access_key=[REDACTED]");
      expect(result.count).toBe(1);
    });
  });

  describe("Anthropic API key", () => {
    test("sk-ant- で始まる長いキーを検出する", () => {
      const fakeKey = "sk-ant-" + "a".repeat(80);
      const text = `key=${fakeKey} end`;
      const result = redactSecrets(text);
      expect(result.text).toBe("key=[REDACTED:ANTHROPIC_API_KEY] end");
      expect(result.count).toBe(1);
    });

    test("sk-ant- だけの短い文字列は検出しない", () => {
      const text = "sk-ant-short";
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });
  });

  describe("OpenAI API key", () => {
    test("sk- で始まる長いキーを検出する", () => {
      const fakeKey = "sk-" + "A".repeat(48);
      const text = `OPENAI_KEY=${fakeKey}`;
      const result = redactSecrets(text);
      expect(result.text).toContain("[REDACTED:OPENAI_API_KEY]");
      expect(result.count).toBeGreaterThanOrEqual(1);
    });

    test("sk- 形式の短い文字列は検出しない", () => {
      const text = "use sk-foo for something";
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });
  });

  describe("GitHub token", () => {
    test("ghp_ プレフィックスのトークンを検出する", () => {
      const fakeToken = "ghp_" + "a".repeat(36);
      const text = `token=${fakeToken}`;
      const result = redactSecrets(text);
      expect(result.text).toBe("token=[REDACTED:GITHUB_TOKEN]");
      expect(result.count).toBe(1);
    });

    test("gho_, ghu_, ghs_, ghr_ プレフィックスも検出する", () => {
      const prefixes = ["gho_", "ghu_", "ghs_", "ghr_"];
      for (const prefix of prefixes) {
        const fakeToken = prefix + "a".repeat(36);
        const result = redactSecrets(`token=${fakeToken}`);
        expect(result.text).toBe("token=[REDACTED:GITHUB_TOKEN]");
        expect(result.count).toBe(1);
      }
    });

    test("ghp_ で始まるが文字数が足りない場合は検出しない", () => {
      const text = "ghp_short";
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });
  });

  describe("Generic API key env assignment", () => {
    test("ANTHROPIC_API_KEY=value 形式を検出する", () => {
      const text = "ANTHROPIC_API_KEY=somerandomvalue123";
      const result = redactSecrets(text);
      expect(result.text).toBe("ANTHROPIC_API_KEY=[REDACTED]");
      expect(result.count).toBe(1);
    });

    test("OPENAI_API_KEY: value 形式（コロン）を検出する", () => {
      const text = "OPENAI_API_KEY: somerandomvalue123";
      const result = redactSecrets(text);
      expect(result.text).toBe("OPENAI_API_KEY=[REDACTED]");
      expect(result.count).toBe(1);
    });

    test("GITHUB_TOKEN, GH_TOKEN, HF_TOKEN も検出する", () => {
      for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "HF_TOKEN"]) {
        const text = `${name}=secretvalue123`;
        const result = redactSecrets(text);
        expect(result.text).toBe(`${name}=[REDACTED]`);
        expect(result.count).toBe(1);
      }
    });

    test("関連しない環境変数名は検出しない", () => {
      const text = "MY_VARIABLE=somevalue";
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });
  });

  describe("SSH private key", () => {
    test("-----BEGIN PRIVATE KEY----- ブロックを検出する", () => {
      const text = `before
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDfake
keycontentokokokokokokokokokokokokok
-----END PRIVATE KEY-----
after`;
      const result = redactSecrets(text);
      expect(result.text).toContain("[REDACTED:SSH_PRIVATE_KEY]");
      expect(result.text).not.toContain("MIIEvAIBADAN");
      expect(result.text).toContain("before");
      expect(result.text).toContain("after");
      expect(result.count).toBe(1);
    });

    test("-----BEGIN RSA PRIVATE KEY----- ブロックを検出する", () => {
      const text = `-----BEGIN RSA PRIVATE KEY-----
fakecontent
-----END RSA PRIVATE KEY-----`;
      const result = redactSecrets(text);
      expect(result.text).toBe("[REDACTED:SSH_PRIVATE_KEY]");
      expect(result.count).toBe(1);
    });

    test("-----BEGIN OPENSSH PRIVATE KEY----- ブロックを検出する", () => {
      const text = `-----BEGIN OPENSSH PRIVATE KEY-----
fakecontent
-----END OPENSSH PRIVATE KEY-----`;
      const result = redactSecrets(text);
      expect(result.text).toBe("[REDACTED:SSH_PRIVATE_KEY]");
      expect(result.count).toBe(1);
    });

    test("複数行にわたる EC, DSA キーも検出する", () => {
      for (const kind of ["EC", "DSA"]) {
        const text = `-----BEGIN ${kind} PRIVATE KEY-----
content
-----END ${kind} PRIVATE KEY-----`;
        const result = redactSecrets(text);
        expect(result.text).toBe("[REDACTED:SSH_PRIVATE_KEY]");
        expect(result.count).toBe(1);
      }
    });
  });

  describe("JWT", () => {
    test("eyJ で始まる 3 セグメントの JWT を検出する", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const text = `Authorization: Bearer ${jwt}`;
      const result = redactSecrets(text);
      expect(result.text).toContain("[REDACTED:JWT]");
      expect(result.text).not.toContain("eyJzdWIiOiI");
      expect(result.count).toBe(1);
    });

    test("eyJ で始まらない通常テキストは検出しない", () => {
      const text = "this is just regular text";
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });
  });

  describe("count accuracy", () => {
    test("複数の異なるパターンを含むテキストの hit 数を正しくカウントする", () => {
      const akia = "AKIAIOSFODNN7EXAMPLE";
      const ghp = "ghp_" + "a".repeat(36);
      const text = `key1=${akia}\ntoken=${ghp}`;
      const result = redactSecrets(text);
      expect(result.count).toBe(2);
      expect(result.text).toContain("[REDACTED:AWS_ACCESS_KEY]");
      expect(result.text).toContain("[REDACTED:GITHUB_TOKEN]");
    });

    test("同一パターンが複数回出現してもそれぞれカウントする", () => {
      const text = `AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7ANOTHER`;
      const result = redactSecrets(text);
      expect(result.count).toBe(2);
      const matches = result.text.match(/\[REDACTED:AWS_ACCESS_KEY\]/g);
      expect(matches?.length).toBe(2);
    });
  });

  describe("idempotency", () => {
    test("既存の [REDACTED:...] プレースホルダはそのまま保持される", () => {
      const text = "key1=[REDACTED:AWS_ACCESS_KEY] and key2=[REDACTED:JWT]";
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });

    test("redact 結果に再度 redact を適用しても変化しない", () => {
      const text = "AKIAIOSFODNN7EXAMPLE";
      const first = redactSecrets(text);
      const second = redactSecrets(first.text);
      expect(second.text).toBe(first.text);
      expect(second.count).toBe(0);
    });
  });

  describe("no secrets", () => {
    test("通常のテキストは変更されず count=0 となる", () => {
      const text = "This is a regular conversation without secrets.";
      const result = redactSecrets(text);
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
    });

    test("空文字列も問題なく処理される", () => {
      const result = redactSecrets("");
      expect(result.text).toBe("");
      expect(result.count).toBe(0);
    });
  });
});
