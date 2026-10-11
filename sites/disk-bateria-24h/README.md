# Disk Bateria 24h: modelo do site

Esqueleto do site novo da **Disk Bateria 24h** (Vitória/ES), montado a partir
do áudio de briefing ([`TRANSCRICAO.md`](TRANSCRICAO.md)) e do site que está no
ar hoje (diskbateria24hs.com.br). A ideia, como diz o áudio, é mostrar pronto
para o cliente e ajustar em cima, em vez de criar do zero com ele.

É um arquivo só: [`index.html`](index.html). Abre direto no navegador, sem
build e sem servidor. Fontes vêm do Google Fonts e o mapa é o embed do Google
Maps; o resto é HTML/CSS/JS dentro do arquivo.

## O que o briefing pediu → onde está no site

| Pedido no áudio | No site |
|---|---|
| "Ego lá em cima": autorizado Moura, o único da Grande Vitória | Selo no topo do hero e seção amarela "Revenda autorizada Moura" |
| Atendimento 24h, e frisar fins de semana e feriados | Título do hero, faixa animada amarela, status "Aberto agora" que mostra o dia e a hora de Vitória |
| O forte dele é Moura e Heliar | Moura e Heliar em destaque na grade de marcas |
| Cores: preto e vermelho da logo, amarelo da Moura | Paleta toda nessas três cores; logo redesenhado em vetor |
| Algo "mais animado, meio mexendo", ele gosta de balão | Bateria carregando animada, balão "24h" flutuando, faixa rolando |
| "Clica no 24 horas e manda pro WhatsApp" | O balão "24h" do hero leva direto ao WhatsApp |
| "Fale com o especialista" / "Agende sua troca de bateria" | Os dois botões principais do hero |
| WhatsApp "carrapato" que acompanha a rolagem | Botão flutuante fixo no canto (no celular, também um botão de ligar) |
| Telefones: 4816 principal, 9396 também, fixo 3324-4040 é o slogan | Fixo em destaque no hero e numa chamada gigante no fim; celulares no topo e no rodapé (ver pendência 1) |
| Firmar o endereço, com foto da loja | Seção "Onde estamos": endereço grande, espaço da foto, mapa e "Como chegar" |
| Check-up elétrico (está gerando? alternador) | Seção escura "Seu carro está gerando?" com bateria, alternador, partida e fuga de corrente |
| Marcas boas e econômicas (Extranger, genéricas...) | Grade de marcas, "da premium à econômica" |
| Não é só carro: estacionária, navio, lancha, moto | Seção "Bateria pra tudo que tem motor", com 6 tipos |
| 10x sem juros como diferencial | Card nos destaques, faixa animada e bloco de pagamento (ver pendência 4) |

Todo botão de WhatsApp já abre a conversa com uma mensagem pronta, diferente
para cada um ("Preciso de bateria para MOTO...", "Quero fazer o CHECK-UP
ELÉTRICO...").

## Pendências antes de publicar

1. **Número completo do celular 4816.** O áudio diz que ele é o principal, mas
   só passa o final. Basta preencher `celularPrincipal` no bloco `CONFIG` (no
   fim do `index.html`): todos os botões de WhatsApp passam a usar esse número
   e o 9396 fica como segundo celular. Até lá, o WhatsApp aponta para o
   (27) 99981-9396.
2. **Foto da fachada da loja.** Há um espaço reservado na seção "Onde estamos",
   com o `<img>` pronto num comentário logo acima.
3. **Lista de marcas.** A grade usa as marcas do site atual (Moura, Heliar,
   Zetta, Júpiter, Extranger, ACDelco, Tudor, Pioneiro). O áudio diz que a
   lista ainda vai ser confirmada com ele, inclusive as genéricas.
4. **"10x sem juros".** O áudio diz que ainda vai confirmar com ele se entra no
   site. E conta que no cartão o preço é maior que à vista. Se for assim,
   anunciar "sem juros" pode ser enquadrado como publicidade enganosa (CDC, art.
   37). Uma saída mais segura é "em até 10x no cartão".
5. **"O único da Grande Vitória".** Aparece no hero e na seção Moura, como o
   cliente quer. É afirmação dele ("segundo ele", no áudio); vale ele confirmar
   que pode sustentar.
6. **Telefones regionais.** O site atual também lista Vila Velha
   (27) 3339-3100 e Serra (27) 3026-7630, e o e-mail
   diskbateria24hs@hotmail.com. O áudio não fala deles; confirmar se ainda
   valem antes de incluir (o e-mail já está no rodapé).
7. **Instagram.** O perfil @diskbateria24h só abre com login, então não deu
   para tirar informação de lá. O link está no rodapé, junto com o Facebook
   /diskbateria24h que aparece no cartão de visita.
