# 見本の本：単位円と三角関数

Ink Reader の見本の本です。読みながら、Apple Pencil で自由に書き込んでみてください。書き込みはこの iPad に保存され、次に開いたときもそのまま残っています。この本は「本」の窓からいつでも消せます。

## 1. 単位円

原点 $O$ を中心とする半径 $1$ の円を **単位円** といいます。$x$ 軸の正の向きから反時計回りに角 $\theta$ だけ回した半径の先を点 $P$ とすると、$P$ の座標で三角関数を決めます。

<figure><svg viewBox="0 0 320 260" width="320" height="260" role="img" aria-label="単位円の上の点 P と、その座標 cos θ と sin θ"><g fill="none" stroke="currentColor" stroke-width="1.2" opacity=".55"><path d="M20 140H300M160 250V20"/><path d="M296 136l4 4-4 4M156 24l4-4 4 4"/></g><circle cx="160" cy="140" r="100" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M160 140L236.6 75.7" stroke="var(--accent)" stroke-width="2"/><path d="M236.6 75.7V140" stroke="var(--accent)" stroke-width="1.4" stroke-dasharray="4 4"/><path d="M160 140H236.6" stroke="var(--accent)" stroke-width="3" opacity=".35"/><path d="M190 140A30 30 0 0 0 183 120.7" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="236.6" cy="75.7" r="4" fill="var(--accent)"/><g fill="currentColor" font-size="15" font-family="serif" font-style="italic"><text x="244" y="70">P</text><text x="146" y="157">O</text><text x="194" y="133">θ</text><text x="304" y="145">x</text><text x="166" y="22">y</text><text x="176" y="160" font-size="13">cos θ</text><text x="231" y="113" font-size="13" text-anchor="end">sin θ</text><text x="262" y="157" font-size="13" font-style="normal">1</text></g></svg></figure>

FIG. 1　単位円の上の点 P。横の長さが cos θ、縦の長さが sin θ になる。

$$P = (\cos\theta,\ \sin\theta)$$

やってみる：図の点 $P$ をペンで丸く囲んでみましょう。線の終わりでペンを止めて少し押さえると、きれいな円に直ります。離さずに動かすと大きさが変わります。

## 2. いちばん大事な式

図の直角三角形に三平方の定理を使うと、斜辺は半径の $1$ なので、どんな $\theta$ でも次の式が成り立ちます。

$$\cos^2\theta + \sin^2\theta = 1$$

やってみる：「マーカー」に持ち替えて、上の式に線を引いてみましょう。マーカーも、線の終わりで止めるとまっすぐになります。

## 3. 角の大きさを長さではかる

角を、単位円の弧の長さではかる方法を **弧度法** といいます。単位は「ラジアン」です。円周の長さは $2\pi$ なので、一周は $2\pi$、半周は $\pi$ です。

$$180^\circ = \pi,\qquad 90^\circ = \frac{\pi}{2},\qquad 60^\circ = \frac{\pi}{3}$$

やってみる：何か書いてから、その線の上をペンでぐちゃぐちゃっと塗ってみましょう。線が消えます。消しゴムを使っても消せます。間違えたときは、紙の左上の矢印で戻せます。

## 4. 加法定理

二つの角を足した角の三角関数は、それぞれの角の三角関数で書けます。

$$\sin(\alpha+\beta) = \sin\alpha\cos\beta + \cos\alpha\sin\beta$$

$$\cos(\alpha+\beta) = \cos\alpha\cos\beta - \sin\alpha\sin\beta$$

やってみる：「投げ縄」で、書いた線を囲んでみましょう。囲んだ線はドラッグで動かせ、出てくるメニューから色を変えたり消したりできます。

## 5. 練習問題

加法定理を使って $\sin 75^\circ$ を求めてください。$75^\circ = 45^\circ + 30^\circ$ と分けるのがこつです。

やってみる：計算する場所が足りなければ、「投げ縄」で横にまっすぐ線を引くと、そこに余白が入ります。余白の下の端のつまみを押すとたためます。

答え：$\sin 75^\circ = \dfrac{\sqrt{6}+\sqrt{2}}{4}$

## 6. Claude と一緒に読む

設定で Google ドライブにつなぐと、書き込みはドライブの「Ink Reader」フォルダに送られます。Claude のドライブ連携で、Claude が本文とあなたの手書きを読めるようになります。分からない所にペンで印を付けて、Claude に聞いてみてください。

自分の md ファイルや PDF は、「本」の「ファイルから開く」で開けます。章の名前を押すと目次が開き、本文を検索できます。段落を指で長押しすると、しおりが付きます。
