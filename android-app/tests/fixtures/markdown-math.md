# 公式渲染验收

行内公式：注意力分数使用 $QK^\mathsf{T} / \sqrt{d_k}$ 缩放。

独立公式：

$$
\operatorname{Attention}(Q,K,V)
=
\operatorname{softmax}\left(\frac{QK^\mathsf{T}}{\sqrt{d_k}}\right)V
$$

普通金额如 $12.50 不应被误判为公式。
