/**
 * NEON UNO MULTIPLAYER - CORE GAME ENGINE
 * 
 * このファイルはゲームのルール、状態管理、AIの思考、およびUIの描画処理を担います。
 * ホストプレイヤーがこのエンジンを管理し、状態をゲストプレイヤーに同期します。
 */

class UnoGame {
  constructor() {
    this.deck = [];
    this.discardPile = [];
    this.players = []; // { id, name, cards: [], isAI: boolean, unoDeclared: boolean }
    this.turn = 0; // 0 ~ 3
    this.direction = 1; // 1: 時計回り, -1: 反時計回り
    this.currentColor = null; // 'red', 'blue', 'green', 'yellow'
    this.currentValue = null; // '0'-'9', 'skip', 'reverse', 'draw2', 'wild', 'wild4'
    
    this.localPlayerId = null; // 自分のPeer ID (または 'host')
    this.isHost = false;
    this.maxPlayers = 4;
    
    // ゲーム進行中の一時選択状態 (Wild用)
    this.pendingWildCard = null; 
    this.unoButtonActive = false; // UNOボタン宣言可能な状態
  }

  // --- ゲーム初期化 (ホストのみが実行) ---
  initGame(playersList) {
    this.isHost = true;
    this.players = playersList.map(p => ({
      id: p.id,
      name: p.name,
      cards: [],
      isAI: p.isAI || false,
      unoDeclared: false
    }));

    // 山札を生成してシャッフル
    this.deck = this.createDeck();
    this.shuffle(this.deck);

    // 各プレイヤーに7枚ずつ配る
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < this.players.length; j++) {
        this.players[j].cards.push(this.deck.pop());
      }
    }

    // 最初のカードを捨て札に置く (ワイルド以外のカードが出るまで繰り返す)
    let firstCard = this.deck.pop();
    while (firstCard.color === 'wild') {
      this.deck.unshift(firstCard); // 山札の底に戻す
      this.shuffle(this.deck);
      firstCard = this.deck.pop();
    }
    
    this.discardPile.push(firstCard);
    this.currentColor = firstCard.color;
    this.currentValue = firstCard.value;
    this.direction = 1;
    this.turn = 0;

    // 最初のカードが特殊カードだった場合の処理
    if (firstCard.value === 'skip') {
      this.turn = this.getNextTurnIndex();
    } else if (firstCard.value === 'reverse') {
      this.direction = -1;
      this.turn = 0; // 4人戦の場合、ホスト(0)から始まりますが方向が反転します
    } else if (firstCard.value === 'draw2') {
      const targetPlayer = this.players[this.turn];
      targetPlayer.cards.push(this.drawCardFromDeck(), this.drawCardFromDeck());
      this.turn = this.getNextTurnIndex(); // 最初の人は引かされてパス
    }
  }

  // 108枚のUNOデッキを作成
  createDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
    const deck = [];
    let idCounter = 0;

    colors.forEach(color => {
      values.forEach(value => {
        // 0は各色1枚、それ以外は各色2枚
        const count = (value === '0') ? 1 : 2;
        for (let i = 0; i < count; i++) {
          deck.push({
            id: `card_${idCounter++}`,
            color: color,
            value: value,
            score: this.getCardScore(value)
          });
        }
      });
    });

    // ワイルドカード (ワイルド、ワイルドドロー4 各4枚)
    for (let i = 0; i < 4; i++) {
      deck.push({
        id: `card_${idCounter++}`,
        color: 'wild',
        value: 'wild',
        score: 50
      });
      deck.push({
        id: `card_${idCounter++}`,
        color: 'wild',
        value: 'wild4',
        score: 50
      });
    }

    return deck;
  }

  getCardScore(value) {
    if (['skip', 'reverse', 'draw2'].includes(value)) return 20;
    if (['wild', 'wild4'].includes(value)) return 50;
    return parseInt(value, 10);
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  // 山札からカードを引き、山札が空なら捨て札をシャッフルして戻す
  drawCardFromDeck() {
    if (this.deck.length === 0) {
      if (this.discardPile.length <= 1) {
        // 捨て札もない場合は、新しくデッキを作って補充
        this.deck = this.createDeck();
        this.shuffle(this.deck);
      } else {
        const topCard = this.discardPile.pop();
        this.deck = [...this.discardPile];
        this.shuffle(this.deck);
        this.discardPile = [topCard];
      }
      showToast("山札が切れたため、捨て札をシャッフルして山札に補充しました。");
    }
    return this.deck.pop();
  }

  // ターンの持ち主インデックスを取得
  getCurrentPlayer() {
    return this.players[this.turn];
  }

  // 次のターンのインデックスを計算
  getNextTurnIndex(steps = 1) {
    let nextIdx = (this.turn + this.direction * steps) % this.players.length;
    if (nextIdx < 0) {
      nextIdx += this.players.length;
    }
    return nextIdx;
  }

  // カードが出せるかどうかのルール判定
  canPlayCard(card) {
    // ワイルドカードはいつでも出せる
    if (card.color === 'wild') return true;

    // 色が一致している、または数字・記号が一致している
    return card.color === this.currentColor || card.value === this.currentValue;
  }

  // --- カードを出すアクション (ホスト・ゲスト共通のロジック実行部) ---
  // ホストで実行され、状態を変更した後に全員にブロードキャストします
  playCard(playerId, cardId, chosenColor = null) {
    const playerIdx = this.players.findIndex(p => p.id === playerId);
    if (playerIdx === -1 || playerIdx !== this.turn) return false;

    const player = this.players[playerIdx];
    const cardIdx = player.cards.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return false;

    const card = player.cards[cardIdx];
    if (!this.canPlayCard(card)) return false;

    // UNOチェック: 手札が2枚から1枚になる際、UNO宣言をしていなければペナルティ
    let penaltyApplied = false;
    if (player.cards.length === 2 && !player.unoDeclared) {
      // UNO宣言漏れペナルティ (2枚ドロー)
      showToast(`${player.name} はUNO宣言を忘れたため、ペナルティとして2枚引きます！`, "warning");
      player.cards.push(this.drawCardFromDeck(), this.drawCardFromDeck());
      penaltyApplied = true;
    }

    // カードを手札から除去し、捨て札へ
    player.cards.splice(cardIdx, 1);
    this.discardPile.push(card);
    this.currentValue = card.value;
    
    // ワイルド以外のカードなら色を同期
    if (card.color !== 'wild') {
      this.currentColor = card.color;
    } else if (chosenColor) {
      this.currentColor = chosenColor;
    }

    // UNO宣言状態のクリア
    player.unoDeclared = false;

    // 勝利判定
    if (player.cards.length === 0) {
      this.endGame(player);
      return true;
    }

    // 特殊カードのエフェクト処理
    let nextSteps = 1;
    let effectText = "";

    if (card.value === 'skip') {
      nextSteps = 2; // 次の人を飛ばす
      effectText = `SKIP! (${this.players[this.getNextTurnIndex()].name})`;
      triggerEffectOverlay("SKIP");
    } else if (card.value === 'reverse') {
      this.direction = -this.direction;
      effectText = "REVERSE!";
      triggerEffectOverlay("REVERSE");
    } else if (card.value === 'draw2') {
      const targetIdx = this.getNextTurnIndex();
      const targetPlayer = this.players[targetIdx];
      targetPlayer.cards.push(this.drawCardFromDeck(), this.drawCardFromDeck());
      nextSteps = 2; // 引かされた人はパス
      effectText = `DRAW 2! (${targetPlayer.name} +2枚)`;
      triggerEffectOverlay("DRAW 2");
    } else if (card.value === 'wild') {
      effectText = `WILD! (指定色: ${this.getColorNameJapanese(this.currentColor)})`;
    } else if (card.value === 'wild4') {
      const targetIdx = this.getNextTurnIndex();
      const targetPlayer = this.players[targetIdx];
      targetPlayer.cards.push(
        this.drawCardFromDeck(), 
        this.drawCardFromDeck(), 
        this.drawCardFromDeck(), 
        this.drawCardFromDeck()
      );
      nextSteps = 2; // 引かされた人はパス
      effectText = `WILD DRAW 4! (${targetPlayer.name} +4枚 & 指定色: ${this.getColorNameJapanese(this.currentColor)})`;
      triggerEffectOverlay("WILD DRAW 4");
    }

    if (effectText) {
      showToast(`${player.name} が ${effectText} をプレイ！`);
    } else {
      showToast(`${player.name} が ${this.getColorNameJapanese(card.color)}の${this.getValueNameJapanese(card.value)} を出しました。`);
    }

    // ターンを進める
    this.turn = this.getNextTurnIndex(nextSteps);
    this.unoButtonActive = false; // ボタンリセット
    return true;
  }

  // 山札からカードを引くアクション
  drawCard(playerId) {
    const playerIdx = this.players.findIndex(p => p.id === playerId);
    if (playerIdx === -1 || playerIdx !== this.turn) return false;

    const player = this.players[playerIdx];
    const newCard = this.drawCardFromDeck();
    player.cards.push(newCard);
    player.unoDeclared = false; // 引いたらUNO宣言クリア

    showToast(`${player.name} が山札から1枚引きました。`);

    // 引いたカードが出せる場合でも、今回はゲームのテンポと通信の安定のため
    // 手札に加えてそのまま次のターンに回すシンプルルールにします
    this.turn = this.getNextTurnIndex();
    this.unoButtonActive = false;
    return true;
  }

  // UNO宣言をする
  declareUno(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return false;

    player.unoDeclared = true;
    showToast(`${player.name} が「UNO！」を宣言しました！`, "success");
    return true;
  }

  // --- AI (コンピュータ) の思考ロジック ---
  // ホストでのみ呼び出されます。
  runAIStep() {
    if (!this.isHost) return;

    const activePlayer = this.getCurrentPlayer();
    if (!activePlayer || !activePlayer.isAI) return;

    // 少し考えているように見せるため、遅延を入れて実行します
    setTimeout(() => {
      // 現在のAIが依然として手番であるか再確認
      if (this.getCurrentPlayer().id !== activePlayer.id) return;

      // 1. 出せるカードがあるかチェック
      const playableCards = activePlayer.cards.filter(c => this.canPlayCard(c));

      // 手札が2枚で、カードを出す＝残り1枚になる場合、AIは高い確率(95%)でUNO宣言を行う
      if (activePlayer.cards.length === 2 && Math.random() < 0.95) {
        this.declareUno(activePlayer.id);
        // 状態を全員に同期
        if (window.broadcastGameState) window.broadcastGameState();
      }

      if (playableCards.length > 0) {
        // 出せるカードがある：AIの優先度戦略
        // 優先度：数字カード > Skip/Reverse > Draw2 > Wild > Wild4 (特殊カードは温存する)
        playableCards.sort((a, b) => {
          const scoreA = this.getCardScore(a.value);
          const scoreB = this.getCardScore(b.value);
          return scoreA - scoreB; // スコアが小さい(数字カード)順にソートして先頭を出す
        });

        const selectedCard = playableCards[0];
        let chosenColor = null;

        // ワイルドカードの場合は、AIの手札で一番多い色を選択
        if (selectedCard.color === 'wild') {
          chosenColor = this.getAIPreferredColor(activePlayer);
        }

        this.playCard(activePlayer.id, selectedCard.id, chosenColor);
      } else {
        // 出せるカードがないので引く
        this.drawCard(activePlayer.id);
      }

      // 状態を全員に同期して再描画
      if (window.broadcastGameState) window.broadcastGameState();
      
      // ゲームが続いており、次のプレイヤーもAIなら連鎖させる
      if (this.deck.length > 0 && !this.isGameOver() && this.getCurrentPlayer().isAI) {
        this.runAIStep();
      }
    }, 1200); // 1.2秒の思考アニメーション風遅延
  }

  // AIがワイルドカードを出す際に指定する色を決める
  getAIPreferredColor(player) {
    const colorCounts = { red: 0, blue: 0, green: 0, yellow: 0 };
    player.cards.forEach(c => {
      if (c.color !== 'wild') {
        colorCounts[c.color]++;
      }
    });

    // 最大枚数の色を選択（同数の場合はランダム）
    let maxColor = 'red';
    let maxVal = -1;
    for (const [color, count] of Object.entries(colorCounts)) {
      if (count > maxVal) {
        maxVal = count;
        maxColor = color;
      }
    }
    return maxColor;
  }

  // ゲーム終了判定
  isGameOver() {
    return this.players.some(p => p.cards.length === 0);
  }

  endGame(winner) {
    showToast(`ゲーム終了！勝者は ${winner.name} です！`, "success");
    
    // スコア(残った手札のカードの合計値)を計算してランキングを作成
    const scoreboard = this.players.map(p => {
      const remainingCardsScore = p.cards.reduce((sum, c) => sum + c.score, 0);
      return {
        name: p.name,
        cardCount: p.cards.length,
        score: remainingCardsScore,
        isLocal: p.id === this.localPlayerId
      };
    });

    scoreboard.sort((a, b) => a.cardCount - b.cardCount); // 枚数が少ない順

    // 結果表示用グローバルコールバックを呼ぶ
    if (window.onGameFinished) {
      window.onGameFinished(winner.name, scoreboard);
    }
  }

  // 日本語名への翻訳ヘルパー
  getColorNameJapanese(color) {
    const names = { red: "赤", blue: "青", green: "緑", yellow: "黄", wild: "ワイルド" };
    return names[color] || color;
  }

  getValueNameJapanese(value) {
    const names = {
      skip: "スキップ",
      reverse: "リバース",
      draw2: "ドロー2",
      wild: "ワイルド",
      wild4: "ワイルド・ドロー4"
    };
    return names[value] || value;
  }
}

// --- UIの描画と構築処理 (グローバル関数) ---

const gameInstance = new UnoGame();

// トースト通知を表示する
function showToast(message, type = "info") {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = '<i class="fa-solid fa-info-circle"></i>';
  if (type === "success") icon = '<i class="fa-solid fa-circle-check"></i>';
  if (type === "warning") icon = '<i class="fa-solid fa-triangle-exclamation"></i>';
  
  toast.innerHTML = `${icon} <span>${message}</span>`;
  container.appendChild(toast);

  // 5秒後に削除
  setTimeout(() => {
    toast.remove();
  }, 5000);
}

// スキップやリバースなどの特殊効果オーバーレイ演出
function triggerEffectOverlay(text) {
  const overlay = document.getElementById('effect-overlay');
  const effectText = document.getElementById('effect-text');
  if (!overlay || !effectText) return;

  effectText.textContent = text;
  overlay.classList.remove('hidden');

  setTimeout(() => {
    overlay.classList.add('hidden');
  }, 1200);
}

// ゲーム画面全体をレンダリングする
function renderGameUI(state) {
  // 1. 各スロットへのプレイヤー配置 (自分を基準として0に固定、時計回りに1, 2, 3へ配置)
  const localPlayerIdx = state.players.findIndex(p => p.id === gameInstance.localPlayerId);
  if (localPlayerIdx === -1) return;

  // 捨て札の一番上のカードを描画
  const discardPile = document.getElementById('discard-pile');
  if (discardPile && state.discardPile.length > 0) {
    const topCard = state.discardPile[state.discardPile.length - 1];
    discardPile.innerHTML = '';
    discardPile.appendChild(createCardDOM(topCard, true));
  }

  // 山札の枚数を更新
  const deckCount = document.getElementById('deck-count');
  if (deckCount) deckCount.textContent = state.deck.length;

  // 指定色表示の更新
  const colorIndicator = document.getElementById('color-indicator');
  const colorDot = document.getElementById('color-dot');
  if (colorIndicator && colorDot) {
    if (state.currentColor) {
      colorIndicator.classList.remove('hidden');
      colorDot.className = `color-dot color-${state.currentColor}`;
    } else {
      colorIndicator.classList.add('hidden');
    }
  }

  // 進行方向の描画
  const directionText = document.getElementById('direction-text');
  const directionIcon = document.getElementById('game-direction').querySelector('i');
  if (directionText && directionIcon) {
    if (state.direction === 1) {
      directionText.textContent = "時計回り";
      directionIcon.className = "fa-solid fa-rotate-right clockwise";
    } else {
      directionText.textContent = "反時計回り";
      directionIcon.className = "fa-solid fa-rotate-left counter-clockwise";
    }
  }

  // メッセージボード
  const msgBox = document.getElementById('game-message');
  const activePlayer = state.players[state.turn];
  const isMyTurn = activePlayer.id === gameInstance.localPlayerId;

  if (msgBox) {
    if (isMyTurn) {
      msgBox.innerHTML = '<span class="text-success"><i class="fa-solid fa-play"></i> あなたのターンです！</span> 出せるカードを選択するか、山札を引いてください。';
    } else {
      msgBox.innerHTML = `<span>${activePlayer.name} のターンです。</span> 考えています...`;
    }
  }

  // UNOボタンの制御
  const unoBtn = document.getElementById('btn-declare-uno');
  if (unoBtn) {
    const myCards = state.players[localPlayerIdx].cards;
    if (isMyTurn && myCards.length === 2) {
      unoBtn.classList.remove('disabled');
      unoBtn.disabled = false;
      if (!state.players[localPlayerIdx].unoDeclared) {
        unoBtn.classList.add('pulse-glow');
      } else {
        unoBtn.classList.remove('pulse-glow');
      }
    } else {
      unoBtn.classList.add('disabled');
      unoBtn.disabled = true;
      unoBtn.classList.remove('pulse-glow');
    }
  }

  // プレイヤー枠 (左, 上, 右) の描画
  // 自分(localPlayerIdx)を基準に、時計回りに他のスロットへマッピング
  // slot 1 (左), slot 2 (上), slot 3 (右)
  const slots = [
    document.getElementById('player-slot-0'), // 画面上は見えないが、状態管理用に定義
    document.getElementById('player-slot-1'), // 左
    document.getElementById('player-slot-2'), // 上
    document.getElementById('player-slot-3')  // 右
  ];

  for (let i = 0; i < 4; i++) {
    const playerStateIdx = (localPlayerIdx + i) % state.players.length;
    const player = state.players[playerStateIdx];
    const slotDOM = slots[i];

    if (!slotDOM) continue;

    // アバター名、カード枚数を更新
    const nameEl = slotDOM.querySelector('.name');
    const badgeEl = slotDOM.querySelector('.card-count-badge');
    const countEl = slotDOM.querySelector('.count');
    const unoEl = slotDOM.querySelector('.uno-badge');
    
    if (nameEl) nameEl.textContent = player.name + (player.isAI ? " (AI)" : "");
    if (countEl) countEl.textContent = player.cards.length;
    
    // 手番中のハイライト
    if (state.turn === playerStateIdx) {
      slotDOM.classList.add('active-turn');
    } else {
      slotDOM.classList.remove('active-turn');
    }

    // UNO!バッジ
    if (player.unoDeclared && unoEl) {
      unoEl.classList.remove('hidden');
    } else if (unoEl) {
      unoEl.classList.add('hidden');
    }
  }

  // 自分自身の手札の描画
  const localHand = document.getElementById('local-hand');
  if (localHand) {
    localHand.innerHTML = '';
    const myCards = state.players[localPlayerIdx].cards;

    // 手札を綺麗に扇状に展開するための計算
    const cardSpacing = 40; // カードの間隔(px)
    const containerWidth = Math.max(280, myCards.length * cardSpacing + (90 - cardSpacing));
    localHand.style.width = `${containerWidth}px`;

    myCards.forEach((card, idx) => {
      const isPlayable = isMyTurn && gameInstance.canPlayCard(card);
      const cardDOM = createCardDOM(card, isPlayable);
      
      // 扇状(ファン)エフェクト用のCSS設定
      const totalCards = myCards.length;
      const midIdx = (totalCards - 1) / 2;
      const diffFromMid = idx - midIdx;
      
      // カード枚数に応じて曲率と回転角度を制御
      const maxRotation = Math.min(25, 40 / Math.max(1, totalCards / 4)); // 最大回転角度
      const rotateDeg = diffFromMid * (maxRotation / Math.max(1, midIdx));
      const translateY = Math.abs(diffFromMid) * (15 / Math.max(1, midIdx));
      const translateX = diffFromMid * cardSpacing;

      cardDOM.style.transform = `translateX(${translateX}px) translateY(${translateY}px) rotate(${rotateDeg}deg)`;
      cardDOM.style.zIndex = 10 + idx;

      // 手札のカードをクリックした際のアクション
      if (isPlayable) {
        cardDOM.onclick = () => playCardAction(card.id);
      }

      localHand.appendChild(cardDOM);
    });
  }
}

// カードDOMを生成する
function createCardDOM(card, isPlayable) {
  const cardDiv = document.createElement('div');
  cardDiv.className = `uno-card ${card.color} ${isPlayable ? 'playable' : 'unplayable'}`;
  cardDiv.dataset.id = card.id;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'card-content';

  const symbolSpan = document.createElement('span');
  symbolSpan.className = 'card-symbol';

  // 記号/数字アイコンの設定
  let symbolHTML = card.value;
  let cornerHTML = card.value;

  if (card.value === 'skip') {
    symbolHTML = '<i class="fa-solid fa-ban"></i>';
    cornerHTML = '<i class="fa-solid fa-ban"></i>';
  } else if (card.value === 'reverse') {
    symbolHTML = '<i class="fa-solid fa-right-left"></i>';
    cornerHTML = '<i class="fa-solid fa-right-left"></i>';
  } else if (card.value === 'draw2') {
    symbolHTML = '+2';
    cornerHTML = '+2';
  } else if (card.value === 'wild') {
    symbolHTML = 'W';
    cornerHTML = 'W';
  } else if (card.value === 'wild4') {
    symbolHTML = '+4';
    cornerHTML = '+4';
  }

  symbolSpan.innerHTML = symbolHTML;
  contentDiv.appendChild(symbolSpan);

  // 四隅のミニ記号
  const topLeft = document.createElement('span');
  topLeft.className = 'card-corner corner-top-left';
  topLeft.innerHTML = cornerHTML;

  const bottomRight = document.createElement('span');
  bottomRight.className = 'card-corner corner-bottom-right';
  bottomRight.innerHTML = cornerHTML;

  cardDiv.appendChild(topLeft);
  cardDiv.appendChild(contentDiv);
  cardDiv.appendChild(bottomRight);

  return cardDiv;
}

// --- プレイヤー操作 (UI経由のアクション) ---

// カードをプレイする
function playCardAction(cardId) {
  const localPlayerIdx = gameInstance.players.findIndex(p => p.id === gameInstance.localPlayerId);
  const card = gameInstance.players[localPlayerIdx].cards.find(c => c.id === cardId);
  
  if (!card) return;

  if (card.color === 'wild') {
    // ワイルドカードの場合は色選択モーダルを表示する
    gameInstance.pendingWildCard = cardId;
    document.getElementById('color-select-modal').classList.remove('hidden');
  } else {
    // 通常のカードはそのままプレイ
    if (gameInstance.isHost) {
      gameInstance.playCard(gameInstance.localPlayerId, cardId);
      // ホストなので、AIのターンチェックを走らせ、状態を同期する
      if (window.broadcastGameState) window.broadcastGameState();
      checkAITurn();
    } else {
      // ゲストなので、ホストへカードプレイのアクションを送信
      if (window.sendActionToHost) {
        window.sendActionToHost({
          type: 'PLAY_CARD',
          cardId: cardId
        });
      }
    }
  }
}

// 色の選択ダイアログ処理
function selectColor(color) {
  document.getElementById('color-select-modal').classList.add('hidden');
  const cardId = gameInstance.pendingWildCard;
  gameInstance.pendingWildCard = null;

  if (gameInstance.isHost) {
    gameInstance.playCard(gameInstance.localPlayerId, cardId, color);
    if (window.broadcastGameState) window.broadcastGameState();
    checkAITurn();
  } else {
    if (window.sendActionToHost) {
      window.sendActionToHost({
        type: 'PLAY_CARD',
        cardId: cardId,
        chosenColor: color
      });
    }
  }
}

// 山札からカードを引く
function drawCardAction() {
  const activePlayer = gameInstance.getCurrentPlayer();
  if (activePlayer.id !== gameInstance.localPlayerId) return; // 自分の番以外は無視

  // 出せるカードがあるかチェック。出せるのに引くのはルール上許可されている
  if (gameInstance.isHost) {
    gameInstance.drawCard(gameInstance.localPlayerId);
    if (window.broadcastGameState) window.broadcastGameState();
    checkAITurn();
  } else {
    if (window.sendActionToHost) {
      window.sendActionToHost({ type: 'DRAW_CARD' });
    }
  }
}

// UNO！の宣言
function declareUnoAction() {
  const localPlayerIdx = gameInstance.players.findIndex(p => p.id === gameInstance.localPlayerId);
  const myCards = gameInstance.players[localPlayerIdx].cards;

  if (myCards.length !== 2) {
    showToast("手札が2枚のときしかUNO宣言はできません。", "warning");
    return;
  }

  if (gameInstance.isHost) {
    gameInstance.declareUno(gameInstance.localPlayerId);
    if (window.broadcastGameState) window.broadcastGameState();
  } else {
    if (window.sendActionToHost) {
      window.sendActionToHost({ type: 'DECLARE_UNO' });
    }
  }
}

// AIのターンであれば動かす (ホストのみ)
function checkAITurn() {
  if (gameInstance.isHost && !gameInstance.isGameOver()) {
    const activePlayer = gameInstance.getCurrentPlayer();
    if (activePlayer && activePlayer.isAI) {
      gameInstance.runAIStep();
    }
  }
}

// ゲームオーバー時の最終結果モーダル表示
window.onGameFinished = (winnerName, scoreboard) => {
  const resultsModal = document.getElementById('results-modal');
  const winnerTitle = document.getElementById('winner-title');
  const winnerMsg = document.getElementById('winner-msg');
  const scoreboardRows = document.getElementById('scoreboard-rows');

  if (!resultsModal || !winnerTitle || !winnerMsg || !scoreboardRows) return;

  winnerTitle.textContent = `勝者: ${winnerName}`;
  if (winnerName === gameInstance.players.find(p => p.id === gameInstance.localPlayerId).name) {
    winnerMsg.innerHTML = '<span class="text-success"><i class="fa-solid fa-trophy"></i> おめでとうございます！あなたの勝利です！</span>';
  } else {
    winnerMsg.textContent = `${winnerName} が先に手札を使い切りました。`;
  }

  // スコアボード描画
  scoreboardRows.innerHTML = '';
  scoreboard.forEach((row, idx) => {
    const tr = document.createElement('tr');
    if (row.isLocal) {
      tr.className = 'highlight-row';
    }
    tr.innerHTML = `
      <td>${idx + 1}位</td>
      <td>${row.name}</td>
      <td>${row.cardCount}枚 (${row.score}点)</td>
    `;
    scoreboardRows.appendChild(tr);
  });

  resultsModal.classList.remove('hidden');
};

// 退出確認
function confirmExitGame() {
  if (confirm("ゲームから退出してロビーに戻りますか？現在の対戦データは破棄されます。")) {
    backToLobby();
  }
}

// ロビーへ戻る
function backToLobby() {
  // すべてのリセット
  document.getElementById('results-modal').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('active');
  document.getElementById('lobby-screen').classList.add('active');
  
  if (window.closeP2PConnection) {
    window.closeP2PConnection();
  }
}
