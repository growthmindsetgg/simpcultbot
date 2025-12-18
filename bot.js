require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const NFT_CONTRACT = process.env.NFT_CONTRACT;
const RPC_URL = process.env.RPC_URL;
const GROUP_ID = process.env.GROUP_ID;
const PRIVATE_LINK = process.env.PRIVATE_LINK;

let db = {};

function loadDb() {
    try {
        db = JSON.parse(fs.readFileSync("database.json"));
    } catch {
        db = {};
    }
}

function saveDb() {
    fs.writeFileSync("database.json", JSON.stringify(db, null, 2));
}

loadDb();

// ------------------------------------------------------
// CHECK IF USER IS ALREADY IN GROUP
// ------------------------------------------------------
async function checkAlreadyMember(userId) {
    try {
        const member = await bot.getChatMember(GROUP_ID, userId);
        if (member.status !== "left" && member.status !== "kicked") {
            return true;
        }
    } catch (e) {
        console.log("checkAlreadyMember error:", e.message);
    }
    return false;
}

// ------------------------------------------------------
// CHECK NFT HOLDING
// ------------------------------------------------------
async function ownsNFT(wallet) {
    try {
        const res = await axios.post(RPC_URL, {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
                {
                    to: NFT_CONTRACT,
                    data:
                        "0x70a08231" +
                        wallet.replace("0x", "").padStart(64, "0")
                },
                "latest",
            ],
        });

        const hex = res.data.result;
        const balance = parseInt(hex, 16);
        return balance > 0;
    } catch (err) {
        console.log("NFT check error:", err);
        return false;
    }
}

// ------------------------------------------------------
// FIXED TX CHECK (MMSCAN, no Cloudflare, 100 percent working)
// ------------------------------------------------------
async function verifyZeroMonTx(wallet, txHash) {
    try {
        const url = `https://mainnet.mmscan.io/api/v2/transactions/${txHash}`;

        const res = await axios.get(url);

        if (!res.data || !res.data.transaction) {
            console.log("No tx data found");
            return false;
        }

        const tx = res.data.transaction;

        if (!tx.from) {
            console.log("Missing sender");
            return false;
        }

        // Sender must match input wallet
        if (tx.from.toLowerCase() !== wallet.toLowerCase()) {
            console.log("Wrong sender");
            return false;
        }

        // Must be exactly 0 MON
        if (Number(tx.value) !== 0) {
            console.log("Not zero MON");
            return false;
        }

        return true;

    } catch (err) {
        console.log("verifyZeroMonTx error:", err.message);
        return false;
    }
}

// ------------------------------------------------------
// DAILY NFT RECHECK (24 hours)
// ------------------------------------------------------
async function dailyRecheck() {
    console.log("Running 24h NFT recheck...");

    for (const uid in db) {
        const user = db[uid];

        if (!user.inGroup) continue;

        const stillHasNFT = await ownsNFT(user.wallet);

        if (!stillHasNFT) {
            if (!user.warned) {
                bot.sendMessage(uid, "Warning: You no longer hold a SIMP CULT NFT. You have 48 hours to re-buy or you will be removed.");
                user.warned = true;
                user.warnTime = Date.now();
                saveDb();
            }
        }
    }
}

setInterval(dailyRecheck, 24 * 60 * 60 * 1000);

// ------------------------------------------------------
// PURGE AFTER 48 HOURS
// ------------------------------------------------------
async function purgeCheck() {
    console.log("Running purge check...");

    for (const uid in db) {
        const user = db[uid];

        if (user.warned && user.warnTime) {
            const hrs = (Date.now() - user.warnTime) / (1000 * 60 * 60);

            if (hrs >= 48) {
                const stillHasNFT = await ownsNFT(user.wallet);

                if (!stillHasNFT) {
                    try {
                        await bot.kickChatMember(GROUP_ID, uid);
                        bot.sendMessage(uid, "You have been removed from the SIMP CULT private group.");

                        user.inGroup = false;
                        user.warned = false;
                        user.warnTime = null;
                        saveDb();
                    } catch (e) {
                        console.log("Kick error:", e.message);
                    }
                }
            }
        }
    }
}

setInterval(purgeCheck, 60 * 60 * 1000);

// ------------------------------------------------------
// BOT FLOW
// ------------------------------------------------------
bot.onText(/\/start/, async (msg) => {
    const uid = msg.from.id.toString();

    const already = await checkAlreadyMember(uid);

    if (already) {
        bot.sendMessage(uid, "You are already verified and part of the SIMP CULT private group.");
        return;
    }

    bot.sendMessage(uid, "Welcome! Send your wallet address to begin verification.");
    db[uid] = db[uid] || { verified: false, inGroup: false };
    db[uid].step = "wallet";
    saveDb();
});

// ----------------------
// LISTEN FOR MESSAGE FLOW
// ----------------------
bot.on("message", async (msg) => {
    const uid = msg.from.id.toString();
    const text = msg.text;

    if (!db[uid] || !db[uid].step) return;

    // STEP 1: wallet input
    if (db[uid].step === "wallet") {
        if (!text.startsWith("0x") || text.length !== 42) {
            bot.sendMessage(uid, "Invalid address. Try again.");
            return;
        }

        const holdsNFT = await ownsNFT(text);

        if (!holdsNFT) {
            bot.sendMessage(uid, "You do NOT hold a SIMP CULT NFT. Verification failed.");
            return;
        }

        db[uid].wallet = text;
        db[uid].step = "tx";
        saveDb();

        bot.sendMessage(uid, "Good. Now send your 0 MON transaction hash.");
        return;
    }

    // STEP 2: tx hash
    if (db[uid].step === "tx") {
        const txHash = text;

        if (!txHash.startsWith("0x") || txHash.length !== 66) {
            bot.sendMessage(uid, "Invalid transaction hash.");
            return;
        }

        const ok = await verifyZeroMonTx(db[uid].wallet, txHash);

        if (!ok) {
            bot.sendMessage(uid, "Transaction is INVALID. Make sure it's a 0 MON transaction from your wallet.");
            return;
        }

        // VERIFIED
        db[uid].verified = true;
        db[uid].txHash = txHash;
        db[uid].warned = false;
        db[uid].warnTime = null;
        db[uid].inGroup = true;
        saveDb();

        bot.sendMessage(uid, "Verified! Here is your private SIMP CULT invite link:\n\n" + PRIVATE_LINK);
    }
});
