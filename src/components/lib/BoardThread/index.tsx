import { format, fromUnixTime, getYear } from 'date-fns';
import Link from 'next/link';
import { Box } from 'src/components/common/Box';
import { Text, TextVariant } from 'src/components/common/Text';
import { ADMIN_EMAIL, HIDDEN_POSTS } from 'src/constants';
import { usePostReplyActions } from 'src/hooks/usePostReplyActions';
import { Post } from 'src/services';

import { CreatePostForm } from '../CreatePostForm';
import { PostComponent } from '../PostComponent';
import { PostMedia } from '../PostMedia';
import { PostText } from '../PostText';
import { StyledPostInfo } from './styles';

const currentYear = getYear(new Date());

export function BoardThread({
  post,
  onRefetch,
  showTag = true,
  ignoreHidden = false,
}: {
  post: Post;
  onRefetch: () => void;
  showTag?: boolean;
  ignoreHidden?: boolean;
}): JSX.Element | null {
  const { handleReply, isFormVisible, setIsFormVisible } = usePostReplyActions();
  const date = fromUnixTime(Number(post.timestamp));
  const time = format(date, currentYear === getYear(date) ? 'HH:mm LLLL dd' : 'HH:mm dd.LL.yyyy');

  if (HIDDEN_POSTS.includes(Number(post.id).toString()) && !ignoreHidden) {
    return null;
  }

  const isThreadPostAction = (
    <Link
      href={`/board/${post.board?.tag}/thread/${post.parent_id || post.id}${ignoreHidden ? '?ignoreHidden=true' : ''}`}
    >
      <Text $color='colorTextLink' $variant={TextVariant.textBodyBold1}>
        В тред
      </Text>
    </Link>
  );

  return (
    <Box $flexDirection='column' $gap='10px' $maxWidth='100%' as='section'>
      <StyledPostInfo $alignItems='baseline' $gap='10px'>
        <Box $flexWrap='wrap' $gap='10px' $alignItems='baseline'>
          {Boolean(showTag) && <Text>/{post.board?.tag}/ </Text>}

          {Boolean(post.subject) && (
            <Text $variant={TextVariant.textBodyBold1}>{post.subject}</Text>
          )}

          <Text $variant={TextVariant.textBodyBold1}>
            {post.is_verify && <Text title='Имеет паспорт вакцинации'>🔰 </Text>}

            {post.poster || 'Anon'}
          </Text>

          <Text>{time}</Text>

          <Text
            onClick={() => handleReply(post?.id?.toString() || '')}
            style={{ cursor: 'pointer' }}
          >
            #{post.id}
          </Text>

          <Text
            $variant={TextVariant.textInput}
            $color='colorTextLink'
            style={{ cursor: 'pointer' }}
          >
            <a
              href={`mailto:${ADMIN_EMAIL}?subject=Жалоба на пост №${post.id}&body=Добрый день. Хочу пожаловаться на пост №${post.id} по причине: _напишите причину здесь_`}
            >
              (пожаловаться)
            </a>
          </Text>
        </Box>

        <Box $minWidth='54px'>{isThreadPostAction}</Box>
      </StyledPostInfo>

      <PostMedia post={post} />

      <PostText post={post} />

      {Boolean(Number(post.replies_count) - Number(post.replies?.length)) && (
        <Box $margin='10px 0'>
          <Text $variant={TextVariant.textBodyBold1}>
            Пропущено {Number(post.replies_count) - Number(post.replies?.length)} постов.&nbsp;
          </Text>

          {isThreadPostAction}
        </Box>
      )}

      {Boolean(post.replies) &&
        post.replies?.map((reply) => (
          <PostComponent
            key={reply.id}
            post={reply}
            onReply={(id) => handleReply(id)}
            ignoreHidden={ignoreHidden}
          />
        ))}

      {isFormVisible && (
        <CreatePostForm
          mode='post'
          parentBoardId={post?.board?.tag?.toString() || ''}
          parentPostId={post?.id?.toString() || ''}
          onCreate={() => {
            onRefetch();
          }}
          changeVisibility={setIsFormVisible}
        />
      )}
    </Box>
  );
}
