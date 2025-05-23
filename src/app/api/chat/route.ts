import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { auth } from "@/server/auth";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { headers } from "next/headers";
import { env } from "@/env";

const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
});

//10 REQUESTS PER 10 SECONDS
const postReqRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "10 s"),
  analytics: true,
});

const ChatBodySchema = z.object({
  message: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const headersList = await headers();
    const ip = headersList.get("x-forwarded-for") ?? "anonymous";

    const { success, limit, reset, remaining } =
      await postReqRateLimit.limit(ip);
    if (!success) {
      return NextResponse.json(
        {
          error: "Too many requests",
          limit,
          reset,
          remaining,
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": limit.toString(),
            "X-RateLimit-Remaining": remaining.toString(),
            "X-RateLimit-Reset": reset.toString(),
          },
        },
      );
    }
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { message } = ChatBodySchema.parse(body);

    if (!message) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }

    const chat = await db.chat.create({
      data: {
        title: "New Chat",
        userId: session.user.id,
      },
    });

    const cacheKey = `user:chats:${session.user.id}`;
    await redis.del(cacheKey);

    const firstMessage = await db.message.create({
      data: {
        content: message,
        role: "USER",
        chatId: chat.id,
        userId: session.user.id,
      },
    });

    return NextResponse.json({
      chatId: chat.id,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: `[[CHAT_POST]] -- ${error}` },
      { status: 500 },
    );
  }
}

const getReqRateLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "10 s"),
  analytics: true,
});

export async function GET(req: NextRequest) {
  try {
    const headersList = await headers();
    const ip = headersList.get("x-forwarded-for") ?? "anonymous";

    const { success, limit, reset, remaining } =
      await getReqRateLimit.limit(ip);
    if (!success) {
      return NextResponse.json(
        {
          error: "Too many requests",
          limit,
          reset,
          remaining,
        },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": limit.toString(),
            "X-RateLimit-Remaining": remaining.toString(),
            "X-RateLimit-Reset": reset.toString(),
          },
        },
      );
    }
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cacheKey = `user:chats:${session.user.id}`;
    const cachedChats = await redis.get<string>(cacheKey);

    if (cachedChats) {
      const chats =
        typeof cachedChats === "string" ? JSON.parse(cachedChats) : cachedChats;

      return NextResponse.json({ chats, cached: true }, { status: 200 });
    }

    const chats = await db.chat.findMany({
      where: {
        userId: session.user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    await redis.set(cacheKey, JSON.stringify(chats), { ex: 300 });

    return NextResponse.json({ chats, cached: false }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: `[[CHAT_GET]] -- ${error}` },
      { status: 500 },
    );
  }
}
