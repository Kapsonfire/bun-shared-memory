# Benchmark 4cab2d0

Date: 2026-10-31T16:14:44.299Z

## Results

| Name                            | Native ops/s | Shared ops/s | Ratio  |
| ------------------------------- | ------------ | ------------ | ------ |
| number · read                   | 11367260670  | 146678486    | 77.50× |
| number · write                  | 989366430    | 23938836     | 41.33× |
| string · read                   | 920883454    | 95589987     | 9.63×  |
| string · write                  | 931152613    | 19431038     | 47.92× |
| boolean · read                  | 504639256    | 94999212     | 5.31×  |
| boolean · write                 | 386539436    | 20192515     | 19.14× |
| bigint · read                   | 627032319    | 82608367     | 7.59×  |
| bigint · write                  | 630039987    | 15984128     | 39.42× |
| number[] · read index           | 559257900    | 59593650     | 9.38×  |
| number[] · write index          | 513820036    | 16812419     | 30.56× |
| number[] · push                 | 142499673    | 10756753     | 13.25× |
| number[] · pop                  | 533338080    | 16239644     | 32.84× |
| string[] · read index           | 540702329    | 66030841     | 8.19×  |
| string[] · write index          | 454214366    | 16794246     | 27.05× |
| string[] · push                 | 136654685    | 10728977     | 12.74× |
| string[] · pop                  | 533687314    | 16443730     | 32.46× |
| boolean[] · read index          | 540452835    | 64928293     | 8.32×  |
| boolean[] · write index         | 506373936    | 16846943     | 30.06× |
| boolean[] · push                | 138187980    | 10845162     | 12.74× |
| boolean[] · pop                 | 542977545    | 16419451     | 33.07× |
| bigint[] · read index           | 541063095    | 65531688     | 8.26×  |
| bigint[] · write index          | 475050325    | 13996910     | 33.94× |
| bigint[] · push                 | 136811186    | 9577204      | 14.29× |
| bigint[] · pop                  | 539675788    | 15569603     | 34.66× |
| mixed[] · read index            | 202614213    | 65363144     | 3.10×  |
| mixed[] · write index           | 206279406    | 16794566     | 12.28× |
| mixed[] · push                  | 137618947    | 10705541     | 12.85× |
| mixed[] · pop                   | 543228022    | 16273483     | 33.38× |
| object · read number prop       | 663347488    | 43737228     | 15.17× |
| object · read string prop       | 619840868    | 40601483     | 15.27× |
| object · read boolean prop      | 936440558    | 42067237     | 22.26× |
| object · read bigint prop       | 588922415    | 41026053     | 14.35× |
| object · write number prop      | 816702922    | 19677737     | 41.50× |
| object · write string prop      | 514804296    | 18950787     | 27.17× |
| object · read array prop index  | 431623927    | 21596712     | 19.99× |
| object · write array prop index | 354346545    | 9100094      | 38.94× |
| object · array prop push        | 125977903    | 8834038      | 14.26× |
| native vs cached shared read    | 658315499    | 39225127     | 16.78× |

## Summary

- Reads: 20.4× slower (min 5.3×, max 77.5×)
- Array reads: 9.5× slower (min 3.1×, max 20.0×)
- Writes: 36.1× slower (min 19.1×, max 47.9×)
- Array writes: 24.7× slower (min 12.3×, max 38.9×)
