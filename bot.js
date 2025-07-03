import { Telegraf, session } from "telegraf";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// .env dosyasını yükle
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error("BOT_TOKEN tanımlanmamış! Lütfen .env dosyasına BOT_TOKEN ekleyin.");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.use(session());

// Kullanıcıdan veri almayı adım adım yönetmek için state:
const steps = [
    "tarih",
    "gun",
    "yolaCikisIl",
    "yolaCikisSaat",
    "konaklamaIl",
    "konaklamaNoktasi",
    "varist",
    "varis",
    "saatDetaylar" // burası özel, çoklu detay
];

// Başlat komutu
bot.start((ctx) => {
    ctx.session.data = {};
    ctx.session.step = 0;
    ctx.session.saatDetaylar = [];
    ctx.reply(
        "Seyir Defteri Raporu oluşturma işlemine başlıyoruz.\nLütfen sırasıyla sorulan bilgileri giriniz.\n\nİlk olarak Tarihi giriniz (YYYY-AA-GG formatında):"
    );
});

// Gelen mesajı step'e göre değerlendiriyoruz
bot.on("text", async (ctx) => {
    const step = ctx.session.step;
    if (step === undefined || step > steps.length) {
        ctx.reply("Başlamak için /start yazınız.");
        return;
    }

    if (!ctx.session.data) ctx.session.data = {};

    if (step < steps.length - 1) {
        // Saat detaylar öncesi tek değer
        const key = steps[step];
        const val = ctx.message.text.trim();

        // Basit doğrulamalar örneğin tarih formatı vs
        if (key === "tarih" || key === "varist") {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
                ctx.reply("Lütfen tarihi YYYY-AA-GG formatında giriniz.");
                return;
            }
        }
        if (key === "yolaCikisSaat" || key === "varis") {
            if (val !== "-" && !/^\d{2}:\d{2}$/.test(val)) {
                ctx.reply("Lütfen saati HH:DD formatında giriniz veya '-' yazınız.");
                return;
            }
        }

        ctx.session.data[key] = val || "-";
        ctx.session.step++;

        if (ctx.session.step < steps.length - 1) {
            const nextKey = steps[ctx.session.step];
            const mesajlar = {
                gun: "Gün (örn: Perşembe):",
                yolaCikisIl: "Yola Çıkış İli:",
                yolaCikisSaat: "Yola Çıkış Saati (HH:DD veya -):",
                konaklamaIl: "Konaklama İli (boşsa '-' yazabilirsiniz):",
                konaklamaNoktasi: "Konaklama Noktası:",
                varist: "Varış Tarihi (YYYY-AA-GG):",
                varis: "Varış Saati (HH:DD veya -):",
            };
            ctx.reply(mesajlar[nextKey] || "Bir sonraki bilgiyi giriniz:");
            return;
        } else {
            // Saat detaylarına geçiş
            ctx.session.step++;
            ctx.reply(
                "Şimdi saat detaylarını ekleyebilirsiniz. Saat ve detay şeklinde yazınız.\nÖrnek: 08:30 Güzergah kontrolü yapıldı\nYeni detay eklemek istemiyorsanız 'bitir' yazınız."
            );
            return;
        }
    } else if (step === steps.length - 1) {
        // saatDetaylar çoklu alım
        const text = ctx.message.text.trim();
        if (text.toLowerCase() === "bitir") {
            ctx.reply("PDF oluşturuluyor, lütfen bekleyin...");
            try {
                const pdfPath = await createPdf(ctx.session.data, ctx.session.saatDetaylar);
                await ctx.replyWithDocument({ source: pdfPath, filename: `SeyirDefteri_${ctx.session.data.tarih}.pdf` });
                fs.unlinkSync(pdfPath);
                ctx.reply("Rapor oluşturuldu ve gönderildi. /start ile yeni rapor oluşturabilirsiniz.");
            } catch (e) {
                ctx.reply("PDF oluşturulurken hata oluştu: " + e.message);
            }
            ctx.session = null;
            return;
        }
        const match = text.match(/^(\d{2}:\d{2})\s+(.+)/);
        if (!match) {
            ctx.reply("Lütfen 'HH:DD detay' formatında yazınız veya 'bitir' yazınız.");
            return;
        }
        const [, saat, detay] = match;
        ctx.session.saatDetaylar.push({ saat, detay });
        ctx.reply(`Saat detayı eklendi: ${saat} - ${detay}\nBaşka detay eklemek için devam edin veya 'bitir' yazınız.`);
    }
});

// PDF oluşturmak için Puppeteer kullanıyoruz
async function createPdf(data, saatDetaylar) {
    const html = `
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8" />
    <title>Seyir Defteri Raporu</title>
    <style>
        body {
            font-family: 'Arial', sans-serif;
            margin: 40px;
            background: #f0f2f5;
            color: #2c3e50;
        }
        h1 {
            text-align: center;
            color: #2980b9;
        }
        .info {
            margin-bottom: 20px;
        }
        .info div {
            margin: 4px 0;
            font-weight: bold;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        th, td {
            border: 1px solid #2980b9;
            padding: 8px;
            text-align: left;
        }
        th {
            background-color: #2980b9;
            color: white;
        }
        tbody tr:nth-child(odd) {
            background: #f2f6fc;
        }
        footer {
            font-size: 10px;
            color: #888;
            margin-top: 40px;
            text-align: center;
        }
    </style>
</head>
<body>
    <h1>Seyir Defteri Raporu</h1>
    <div class="info">
        <div>Tarih: ${data.tarih}</div>
        <div>Gün: ${data.gun}</div>
        <div>Yola Çıkış İli: ${data.yolaCikisIl}</div>
        <div>Yola Çıkış Saati: ${data.yolaCikisSaat}</div>
        <div>Konaklama İli: ${data.konaklamaIl}</div>
        <div>Konaklama Noktası: ${data.konaklamaNoktasi}</div>
        <div>Varış Tarihi: ${data.varist}</div>
        <div>Varış Saati: ${data.varis}</div>
    </div>
    <table>
        <thead>
            <tr><th>Saat</th><th>Detay</th></tr>
        </thead>
        <tbody>
            ${saatDetaylar.map(d => `<tr><td>${d.saat}</td><td>${d.detay}</td></tr>`).join("")}
        </tbody>
    </table>
    <footer>
        Raporlama Tarihi: ${new Date().toLocaleString("tr-TR")}
    </footer>
</body>
</html>
  `;

    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfPath = path.join(process.cwd(), `SeyirDefteri_${data.tarih}.pdf`);
    await page.pdf({
        path: pdfPath,
        format: "A4",
        printBackground: true,
        margin: { top: "40px", bottom: "40px", left: "30px", right: "30px" },
    });
    await browser.close();
    return pdfPath;
}

bot.launch();
console.log("Bot çalışıyor...");
