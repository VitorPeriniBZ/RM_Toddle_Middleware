# Disk Bateria 24h: modelo do site

Esqueleto do site novo da **Disk Bateria 24h** (Vitória/ES), montado a partir
do áudio de briefing ([`TRANSCRICAO.md`](TRANSCRICAO.md)) e do site que está no
ar hoje (diskbateria24hs.com.br). A ideia, como diz o áudio, é mostrar pronto
para o cliente e ajustar em cima, em vez de criar do zero com ele.

É um arquivo só: [`index.html`](index.html). Abre direto no navegador, sem
build e sem servidor. Tudo vai dentro do arquivo, inclusive as fontes (Barlow e
Barlow Condensed, licença OFL) e a foto da Moura, então ele abre igual mesmo
sem internet. Só o mapa depende de conexão (é o embed do Google Maps).

## O que o briefing pediu → onde está no site

| Pedido no áudio | No site |
|---|---|
| "Ego lá em cima": ele é o único revendedor autorizado Moura da Grande Vitória | "Único revendedor autorizado Moura da Grande Vitória" no topo do hero, nos destaques, na faixa e na seção amarela, com a foto da bateria Moura e um selo |
| Atendimento 24h, e frisar fins de semana e feriados; "o único da Grande Vitória que entrega 24 horas" | Título do hero, selo "A única loja de bateria 24h da Grande Vitória", destaques, faixa animada e status "Aberto agora", que mostra o dia e a hora de Vitória |
| O forte dele é Moura e [Heliar?] | Moura e Heliar com etiqueta de destaque nos cards de marcas (Heliar a confirmar, ver pendência 2) |
| Cores: preto e vermelho da logo, amarelo da Moura | Paleta toda nessas três cores; logo redesenhado em vetor |
| Algo "mais animado, meio mexendo", ele gosta de balão | Bateria carregando animada, balão "24h" flutuando, faixa rolando |
| "Clica no 24 horas e manda pro WhatsApp" | O balão "24h" do hero leva direto ao WhatsApp |
| "Fale com o especialista" / "Agende sua troca de bateria" | Os dois botões principais do hero |
| WhatsApp "carrapato" que acompanha a rolagem | Botão flutuante fixo no canto |
| Telefones: 4816 principal, 9396 também, fixo 3324-4040 é o slogan | Ajustado na revisão (ver abaixo): só o WhatsApp (27) 99902-4816 em destaque; o fixo fica no rodapé |
| Firmar o endereço, com foto da loja | Seção "Onde estamos": endereço grande, espaço da foto, mapa e "Como chegar" |
| Check-up elétrico (está gerando? alternador) | Seção escura "Seu carro está gerando?" com bateria, alternador, partida e fuga de corrente |
| Marcas boas e econômicas (Extranger, genéricas...) | Seção "Da premium à econômica": cards no formato dos stories do Instagram (Moura, Heliar, Zetta, Tudor, ACDelco) e uma linha "+ Extranger e outras opções econômicas" |
| Não é só carro: estacionária, navio, lancha, moto | Seção "Bateria pra tudo que tem motor", com 6 tipos |
| 10x sem juros como diferencial | Card nos destaques, faixa animada e bloco de pagamento (ver pendência 3) |

Todo botão de WhatsApp já abre a conversa com uma mensagem pronta, diferente
para cada um ("Preciso de bateria para MOTO...", "Quero fazer o CHECK-UP
ELÉTRICO...").

## Definido na revisão do modelo

Pontos em que o site segue a revisão, e não o áudio ao pé da letra:

- **"Único".** O áudio diz "único" duas vezes, e as duas frases saem iguais em
  todas as transcrições (com e sem dica de contexto):
  - [00:12] "Que ele é autorizado da Moura, ele é o único aqui da Grande
    Vitória." O site usa: **único revendedor autorizado Moura da Grande
    Vitória**.
  - [01:35] "O único da Grande Vitória que entrega 24 horas, segundo ele."
    Numa primeira revisão isso saiu do site. Na seguinte, foi pedido para
    voltar, com a frase da bio do Instagram ("A ÚNICA loja de bateria que
    atende em toda Grande Vitória, 24h!!"). O site usa: **a única loja de
    bateria que atende 24h em toda a Grande Vitória**.
- **Telefones.** O WhatsApp principal é o **(27) 99902-4816** (o "Disk 2" dos
  links do Instagram). Ele está em todos os botões, no topo, no hero e na
  chamada final. O fixo (27) 3324-4040 aparece só no rodapé. O
  (27) 99981-9396 não entra. Para trocar um número, basta editar o bloco
  `CONFIG` no fim do `index.html`.
- **Endereço.** "Rua Aloísio Simões, 625", como está no Instagram (o site
  antigo dizia "Av."). O CEP do Instagram (29050-010) não foi usado: a consulta
  dos Correios dá esse CEP como inválido.
- **Imagens e logos das marcas.** Liberadas na revisão. Os cards de marcas são
  recortes dos stories de marcas do Instagram da loja (sem a barra do perfil).
  A foto da bateria Moura na seção amarela é a imagem oficial do site
  moura.com.br. Tudo vai embutido no `index.html`.

## Pendências antes de publicar

1. **Foto da fachada da loja.** Há um espaço reservado na seção "Onde estamos",
   com o `<img>` pronto num comentário logo acima.
2. **Marcas.** Os cards seguem os stories do Instagram, mas só 5 dos 7 stories
   vieram nos prints (Moura, Heliar, Zetta, Tudor e ACDelco). Se os outros
   dois forem marcas, dá para incluir do mesmo jeito. Extranger aparece só em
   texto, porque é citada no áudio. Confirmar também se a Heliar é mesmo "o
   outro forte" dele: em 00:26 o áudio não é nítido (ver a nota na
   transcrição). Se não for, a Heliar aparece em três pontos para ajustar: a
   etiqueta no card da Heliar, o texto de abertura da seção Marcas e a última
   frase do texto da seção Moura.
3. **"10x sem juros".** O áudio diz que ainda vai confirmar com ele se entra no
   site. E conta que no cartão o preço é maior que à vista. Se for assim,
   anunciar "sem juros" pode ser enquadrado como publicidade enganosa (CDC, art.
   37). Uma saída mais segura é "em até 10x no cartão".
4. **Outros contatos do site antigo.** Vila Velha (27) 3339-3100, Serra
   (27) 3026-7630 e o e-mail diskbateria24hs@hotmail.com. O e-mail está no
   rodapé; os dois telefones não entraram. Confirmar se o e-mail ainda vale.
