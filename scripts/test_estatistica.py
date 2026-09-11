"""Testes das funções estatísticas.  Rodar: pnpm test:py"""

import unittest

from estatistica import delta_cliff, holm, kruskal_wallis, magnitude_cliff, mann_whitney, resumo


class TestResumo(unittest.TestCase):
    def test_media_dp_mediana(self):
        r = resumo([1, 2, 3, 4, 5])
        self.assertAlmostEqual(r["media"], 3)
        self.assertAlmostEqual(r["dp"], 1.5811388, places=6)
        self.assertEqual(r["mediana"], 3)
        self.assertEqual(r["n"], 5)

    def test_ignora_ausentes(self):
        self.assertEqual(resumo([1, None, float("nan"), 3])["n"], 2)


class TestMannWhitney(unittest.TestCase):
    def test_separacao_total_n5(self):
        # Separação completa com 5 × 5: p exato = 2 / C(10, 5) = 2/252.
        _, p = mann_whitney([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])
        self.assertAlmostEqual(p, 2 / 252, places=10)

    def test_simetria(self):
        _, p1 = mann_whitney([1.1, 2.5, 3.2], [2.0, 4.1, 5.3, 6.0])
        _, p2 = mann_whitney([2.0, 4.1, 5.3, 6.0], [1.1, 2.5, 3.2])
        self.assertAlmostEqual(p1, p2, places=12)

    def test_valor_conhecido(self):
        # x = {1,3,5}, y = {2,4,6,8}: U(x) = 3 (3>2, 5>2, 5>4); P(U ≤ 3) = 7/35 → p = 14/35.
        u, p = mann_whitney([1, 3, 5], [2, 4, 6, 8])
        self.assertEqual(u, 3)
        self.assertAlmostEqual(p, 14 / 35, places=10)

    def test_empates_usa_aproximacao(self):
        _, p = mann_whitney([1, 1, 2, 2], [1, 2, 3, 3])
        self.assertTrue(0 < p <= 1)


class TestKruskal(unittest.TestCase):
    def test_grupos_bem_separados(self):
        h, p = kruskal_wallis([[1, 2, 3, 4, 5], [11, 12, 13, 14, 15], [21, 22, 23, 24, 25]], permutacoes=5000)
        self.assertAlmostEqual(h, 12.5, places=6)
        self.assertLess(p, 0.01)

    def test_grupos_iguais(self):
        _, p = kruskal_wallis([[1, 4, 7], [2, 5, 8], [3, 6, 9]], permutacoes=5000)
        self.assertGreater(p, 0.5)


class TestHolm(unittest.TestCase):
    def test_ajuste(self):
        self.assertEqual([round(v, 6) for v in holm([0.01, 0.04, 0.03])], [0.03, 0.06, 0.06])


class TestCliff(unittest.TestCase):
    def test_extremos(self):
        self.assertEqual(delta_cliff([6, 7], [1, 2]), 1.0)
        self.assertEqual(delta_cliff([1, 2], [6, 7]), -1.0)
        self.assertEqual(magnitude_cliff(0.5), "grande")
        self.assertEqual(magnitude_cliff(0.1), "desprezível")


if __name__ == "__main__":
    unittest.main()
