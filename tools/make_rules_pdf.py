"""Gera REGRAS.pdf (PT) e RULES.pdf (EN) na raiz do repositório.

Os textos seguem o REGRAS.md e o painel "Como jogar" do jogo — quando as
regras mudarem, atualiza os três sítios e volta a correr este script.

Requer: pip install reportlab
Uso:    python tools/make_rules_pdf.py [pasta_de_saída]
"""
import sys, os
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                ListFlowable, ListItem, HRFlowable, KeepTogether)

AMBER, AMBER2, INK, MUTED, TAN, CREAM = (HexColor(c) for c in
    ('#c47c28', '#a66018', '#2e1a0a', '#9a7050', '#d4b896', '#fffaf0'))
LILY = {'Y': ('#fff3c8', '#8a5a00'), 'R': ('#ffe8e0', '#8a2810'),
        'W': ('#e8eef4', '#3a5068'), 'B': ('#e0f0f8', '#185888')}

title = ParagraphStyle('t', fontName='Helvetica-Bold', fontSize=34, leading=40, textColor=AMBER, alignment=TA_CENTER)
tag = ParagraphStyle('g', fontName='Helvetica-Oblique', fontSize=12, leading=14, textColor=MUTED, alignment=TA_CENTER)
h2 = ParagraphStyle('h', fontName='Helvetica-Bold', fontSize=15, leading=22, textColor=AMBER2, spaceBefore=14, spaceAfter=6)
body = ParagraphStyle('b', fontName='Helvetica', fontSize=10.3, leading=15, textColor=INK, spaceAfter=6)
cell = ParagraphStyle('c', parent=body, alignment=TA_CENTER, spaceAfter=0)
head = ParagraphStyle('hc', parent=cell, fontName='Helvetica-Bold', textColor=white)
foot = ParagraphStyle('f', fontName='Helvetica-Oblique', fontSize=8.5, leading=12, textColor=MUTED, alignment=TA_CENTER)


def P(t, s=body): return Paragraph(t, s)
def H(t): return P(t, h2)
def bullets(items):
    return ListFlowable([ListItem(P(i), leftIndent=14, value='circle') for i in items],
                        bulletType='bullet', bulletFontSize=6, leftIndent=14, spaceAfter=6)
def table(rows, widths):
    t = Table([[P(c, head) for c in rows[0]]] + [[P(c, cell) for c in r] for r in rows[1:]],
              colWidths=widths, hAlign='CENTER')
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), AMBER),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [CREAM, white]),
        ('GRID', (0, 0), (-1, -1), 0.5, TAN),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    return t
def lilies(names):
    t = Table([[P('<font color="%s">%s</font>' % (LILY[k][1], n)) for k, n in names]], colWidths=[90] * 4, hAlign='LEFT')
    t.setStyle(TableStyle([('BACKGROUND', (i, 0), (i, 0), HexColor(LILY[k][0])) for i, (k, _) in enumerate(names)] +
                          [('TOPPADDING', (0, 0), (-1, -1), 1), ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
                           ('LEFTPADDING', (0, 0), (-1, -1), 6)]))
    return t

DECK = [['1', '6'], ['2', '13'], ['3', '11'], ['4', '4'], ['5', '2']]

PT = dict(
    file='REGRAS.pdf', title='Capivaras — Regras do Jogo', tagline='Um jogo de apostas secretas no Pantanal',
    story=lambda: [
        H('O Pantanal acorda…'),
        P('No coração húmido do Pantanal, uma colónia de capivaras relaxa ao sol. Chegaram os humanos — cada um quer dar festinhas nas suas favoritas. Mas as capivaras são tímidas: se dois humanos se aproximarem ao mesmo tempo, fogem imediatamente. Só o jogador que chegar <b>sozinho</b> ganha a sua capivara.'),
        H('Como entrar num jogo'),
        P('<b>Primeira vez?</b> Carrega em <b>Tutorial</b>, no ecrã inicial ou no lobby: é um tour guiado de 2 minutos, com duas rondas de treino contra bots, que te mostra o ecrã do jogo e as regras em ação. Não cria nenhuma mesa nem conta para nada.'),
        bullets([
            '<b>Mesas multijogador</b> (Mesa 1 a Mesa 5) — até 6 jogadores humanos por mesa. O primeiro jogador a entrar é o anfitrião e é quem carrega em <b>"Iniciar Jogo"</b> quando houver pelo menos 2 jogadores sentados.',
            '<b>Mesa Solo (vs 2 IAs)</b> — entras sozinho e o jogo começa logo, contra dois bots. Esta mesa é sempre privada, criada só para ti.',
            'Se a ligação cair a meio do jogo, tens <b>45 segundos</b> para voltar a abrir a página — o teu lugar fica reservado.',
        ]),
        H('Objetivo'),
        P('Terminar o jogo com mais pontos do que os outros jogadores. Os pontos vêm de três fontes: as capivaras que apanhas, o token do pássaro e o bónus dos nenúfares.'),
        H('Cada ronda'),
        P('A cada ronda, são colocadas na mesa <b>tantas cartas quantos os jogadores</b>, viradas para cima e identificadas por letra (A, B, C…). Em segredo, cada jogador escolhe <b>uma</b> dessas cartas para apostar. Não há turnos nem ordem de jogo: ninguém vê a escolha dos outros, por isso apostar mais cedo ou mais tarde não dá vantagem. Quando todos estiverem prontos, as apostas revelam-se ao mesmo tempo:'),
        bullets([
            '<b>Sozinho</b> — foste o único a escolher essa carta? É tua!',
            '<b>Empate</b> — mais de um jogador escolheu a mesma carta? Ninguém a ganha — as capivaras fugiram e a carta vai para o descarte.',
            '<b>Sem apostas</b> — ninguém escolheu uma carta? Também vai para o descarte.',
        ]),
        P('Numa mesa multijogador tens tanto tempo quanto precisares para apostar enquanto estiveres ligado — só é feita uma aposta automática (aleatória) em teu nome se ficares desligado a meio de uma ronda. Na Mesa Solo, os bots apostam sozinhos, poucos segundos depois de a ronda começar.'),
        H('O pássaro amarelo'),
        P('Algumas cartas têm um pássaro amarelo desenhado.'),
        bullets([
            'A <b>primeira</b> vez que alguém apanha uma carta com pássaro, fica com o <b>token do pássaro</b> (<b>+5 pontos</b>).',
            'Para o <b>roubar</b>, é preciso ter <b>mais</b> cartas com pássaro do que o detentor atual (pelo menos mais uma) — não basta empatar.',
            '<b>Empates não movem o token.</b> Se dois jogadores ultrapassarem o detentor na mesma ronda e ficarem empatados entre si, o token fica com o detentor; se um deles ficar à frente do outro, é esse que fica com o token.',
            '<b>Empate na primeira carta com pássaro:</b> o token fica na mesa e vai para o primeiro jogador que tiver mais cartas com pássaro do que o empate (se o empate foi a uma carta, fica com ele quem chegar primeiro às duas).',
        ]),
        H('Os nenúfares'),
        P('Certas cartas têm nenúfares coloridos. Reúne as <b>quatro cores</b> — não precisam de estar todas na mesma carta — para ganhar um bónus de <b>+10 pontos</b>.'),
        lilies([('Y', 'Amarelo'), ('R', 'Vermelho'), ('W', 'Branco'), ('B', 'Azul')]),
        H('O baralho'),
        P('O baralho tem <b>36 cartas</b>, com capivaras representando de 1 a 5 pontos cada:'),
        table([['Capivaras na carta', 'Nº de cartas']] + DECK, [180, 180]),
        Spacer(1, 6),
        P('O baralho <b>joga-se duas vezes</b>: quando as cartas acabam pela primeira vez, o descarte (as cartas que ninguém ganhou, por empate ou por falta de apostas) é baralhado e volta a ser usado. As cartas ganhas ficam com quem as ganhou e não voltam ao jogo. Quando o baralho acaba pela segunda vez, o jogo termina e contam-se os pontos finais.'),
        KeepTogether([H('Pontuação final'),
            table([['Fonte', 'Pontos'],
                   ['Cada capivara nas cartas que recolheste (soma do valor de cada carta)', 'igual ao nº de capivaras na carta'],
                   ['Teres o token do pássaro no final do jogo', '<b>+5</b>'],
                   ['Teres as 4 cores de nenúfar', '<b>+10</b>']], [250, 120])]),
        Spacer(1, 6),
        P('Ganha quem tiver mais pontos no total. Em caso de empate no valor máximo, o primeiro jogador com essa pontuação é indicado como vencedor.'),
        P('Ao contrário do jogo físico, aqui não precisas de esperar pelo fim para fazer contas: os painéis dos jogadores mostram a pontuação em tempo real, já com o token do pássaro e o bónus dos nenúfares incluídos.'),
        H('Dicas'),
        bullets([
            'Repara nas cores de nenúfar que já tens e nas que ainda te faltam — vale a pena arriscar numa carta de valor mais baixo se te faltar só uma cor para o bónus de +10.',
            'Ficar de olho em quem tem o token do pássaro (e quantas cartas com pássaro cada um já tem) ajuda a decidir se vale a pena tentar roubá-lo.',
            'Apostar sempre na carta de maior valor nem sempre compensa — se for óbvia, é provável que outro jogador escolha a mesma e a carta escape a ambos.',
            'No fim do jogo, o anfitrião de uma mesa multijogador pode iniciar uma nova partida com "Jogar Novamente"; na Mesa Solo isso está sempre disponível.',
        ]),
        Spacer(1, 10),
        P('Estas regras correspondem ao painel "Como jogar" dentro do próprio jogo — podes consultá-lo a qualquer momento durante a partida.', foot),
        P('Um jogo de David Marques · CC BY-NC-ND 4.0', foot),
    ])

EN = dict(
    file='RULES.pdf', title='Capivaras — Game Rules', tagline='A game of secret bets in the Pantanal',
    story=lambda: [
        H('The Pantanal wakes up…'),
        P('In the humid heart of the Pantanal, a colony of capybaras is relaxing in the sun. The humans have arrived — each one wants to pet their favourite. But the capybaras are shy: if two humans approach at the same time, they scurry off immediately. Only the player who approaches <b>alone</b> gets to keep their capybara.'),
        H('Joining a game'),
        P('<b>First time?</b> Press <b>Tutorial</b> on the start screen or in the lobby: a 2-minute guided tour with two practice rounds against bots that shows you the game screen and the rules in action. It doesn\'t create any table and nothing counts.'),
        bullets([
            '<b>Multiplayer tables</b> (Table 1 to Table 5) — up to 6 human players per table. The first player to join becomes the host and is the one who clicks <b>"Start Game"</b> once at least 2 players are seated.',
            '<b>Solo table (vs 2 bots)</b> — you join alone and the game starts right away, against two bots. This table is always private, created just for you.',
            'If your connection drops mid-game, you have <b>45 seconds</b> to reopen the page — your seat stays reserved.',
        ]),
        H('Objective'),
        P('Finish the game with more points than the other players. Points come from three sources: the capybaras you collect, the bird token and the water-lily bonus.'),
        H('Each round'),
        P('Each round, <b>as many cards as there are players</b> are placed on the table, face up and labelled with a letter (A, B, C…). In secret, every player picks <b>one</b> of those cards to bet on. There are no turns and no playing order: nobody sees the others\' choices, so betting earlier or later gives no advantage. Once everyone is ready, all bets are revealed at the same time:'),
        bullets([
            '<b>Alone</b> — were you the only one who picked that card? It\'s yours!',
            '<b>Tie</b> — did more than one player pick the same card? Nobody wins it — the capybaras scattered and the card goes to the discard pile.',
            '<b>No bets</b> — did nobody pick a card? It also goes to the discard pile.',
        ]),
        P('At a multiplayer table you have as much time as you need to bet while you stay connected — an automatic (random) bet is only placed on your behalf if you disconnect mid-round. At the Solo table, the bots bet on their own, a few seconds after the round starts.'),
        H('The yellow bird'),
        P('Some cards have a yellow bird drawn on them.'),
        bullets([
            'The <b>first</b> time anyone collects a bird card, they receive the <b>bird token</b> (<b>+5 points</b>).',
            'To <b>steal</b> it, you need <b>more</b> bird cards than the current holder (at least one more) — matching them isn\'t enough.',
            '<b>Ties don\'t move the token.</b> If two players overtake the holder in the same round and are tied with each other, the holder keeps it; if one of them is ahead of the other, that player takes it.',
            '<b>Tie on the first bird card:</b> the token stays on the table and goes to the first player who has more bird cards than the tie (if the tie was at one card, whoever gets to two first takes it).',
        ]),
        H('The water lilies'),
        P('Certain cards have coloured water lilies. Collect all <b>four colours</b> — they don\'t need to be on the same card — to earn a <b>+10 point</b> bonus.'),
        lilies([('Y', 'Yellow'), ('R', 'Red'), ('W', 'White'), ('B', 'Blue')]),
        H('The deck'),
        P('The deck has <b>36 cards</b>, showing between 1 and 5 capybaras each:'),
        table([['Capybaras on card', 'Number of cards']] + DECK, [180, 180]),
        Spacer(1, 6),
        P('The deck is <b>played through twice</b>: the first time it runs out, the discard pile (the cards nobody won, through a tie or no bets) is reshuffled and play continues. Won cards stay with whoever won them and never come back. The second time the deck runs out, the game ends and final scores are tallied.'),
        KeepTogether([H('Final scoring'),
            table([['Source', 'Points'],
                   ["Each capybara on the cards you collected (sum of each card's value)", 'equal to the number of capybaras on the card'],
                   ['Holding the bird token at the end of the game', '<b>+5</b>'],
                   ['Holding all 4 water-lily colours', '<b>+10</b>']], [250, 120])]),
        Spacer(1, 6),
        P('Whoever has the most points overall wins. In case of a tie for the highest score, the first player with that score is shown as the winner.'),
        P('Unlike the physical game, you don\'t have to wait for the end to do the maths: the player panels show the score in real time, already including the bird token and the water-lily bonus.'),
        H('Tips'),
        bullets([
            'Keep track of which water-lily colours you already have and which you\'re missing — it can be worth risking a lower-value card if you only need one more colour for the +10 bonus.',
            'Keep an eye on who holds the bird token (and how many bird cards each player has) to judge whether trying to steal it is worth it.',
            'Always betting on the highest-value card doesn\'t always pay off — if it\'s the obvious pick, another player is likely to choose it too, and the card will slip away from both of you.',
            'At the end of a game, the host of a multiplayer table can start a new match with "Play Again"; at the Solo table that option is always available.',
        ]),
        Spacer(1, 10),
        P('These rules match the "How to play" panel inside the game itself — you can check it at any point during a match.', foot),
        P('A game by David Marques · CC BY-NC-ND 4.0', foot),
    ])


def build(cfg, outdir):
    doc = SimpleDocTemplate(os.path.join(outdir, cfg['file']), pagesize=A4, title=cfg['title'],
                            author='David Marques', leftMargin=62.7, rightMargin=62.7, topMargin=50, bottomMargin=50)
    doc.build([P('Capivaras', title), P(cfg['tagline'], tag), Spacer(1, 4),
               HRFlowable(width='100%', thickness=1, color=TAN, spaceAfter=4)] + cfg['story']())


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
    for cfg in (PT, EN):
        build(cfg, out)
        print('gerado', os.path.normpath(os.path.join(out, cfg['file'])))
